/**
 * v2.0：給 AI 看的去識別化收支摘要、日常預算、預算建議套用、快取鍵
 */
import { describe, expect, it } from 'vitest';
import { buildFinanceSummary, dailyAllowance, hashJson, monthlyFixed, monthRanges, periodToAi, planToBudgetInputs, type SummaryInput } from '@/domain/aisummary';
import type { Category } from '@/db/types';
import type { PeriodSummary } from '@/domain/summary';

const cats: SummaryInput['cats'] = [
  { id: 'food', name: '飲食', kind: 'expense', parentId: '' },
  { id: 'lunch', name: '午餐', kind: 'expense', parentId: 'food' },
  { id: 'taxi', name: '交通', kind: 'expense', parentId: '' },
  { id: 'salary', name: '薪資', kind: 'income', parentId: '' },
];
const base = (txs: SummaryInput['txs']): SummaryInput => ({
  today: '2026-10-15', currency: 'TWD', decimals: 2, monthStartDay: 1, txs, cats,
  fixed: { subscriptions: 0, installments: 0, loans: 0, otherRecurring: 0 }, budgets: [], goals: [],
});
const tx = (date: string, amount: number, type: 'expense' | 'income' = 'expense', categoryId = 'lunch') => ({ date, type, categoryId, amount: amount * 100 });

describe('monthRanges', () => {
  it('由舊到新，最後一個是本期', () => {
    const r = monthRanges('2026-10-15', 1, 3);
    expect(r.map((x) => x.start)).toEqual(['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']);
    expect(r[3].end).toBe('2026-10-31');
  });
  it('記帳月起算日 5 號', () => {
    expect(monthRanges('2026-10-03', 5, 1).map((x) => [x.start, x.end])).toEqual([['2026-08-05', '2026-09-04'], ['2026-09-05', '2026-10-04']]);
  });
});

describe('buildFinanceSummary', () => {
  const s = buildFinanceSummary(base([
    tx('2026-08-10', 3000), tx('2026-08-11', 1000, 'expense', 'taxi'), tx('2026-08-25', 50000, 'income', 'salary'),
    tx('2026-09-10', 5000), tx('2026-09-12', 2000, 'expense', 'taxi'), tx('2026-09-25', 50000, 'income', 'salary'),
    tx('2026-10-05', 800),
  ]));
  it('子分類併入主分類、金額轉整數元', () => {
    const sep = s.months.find((m) => m.label === '2026-09')!;
    expect(sep.expense).toBe(7000);
    expect(sep.byCategory).toEqual({ 飲食: 5000, 交通: 2000 });
    expect(sep.income).toBe(50000);
  });
  it('本期標示 partial 並帶已過天數，不列入平均', () => {
    const cur = s.months[s.months.length - 1];
    expect(cur).toMatchObject({ label: '2026-10', partial: true, daysElapsed: 15, expense: 800 });
    expect(s.completedMonths).toBe(2);
    expect(s.avgExpense).toBe(5500); // (4000 + 7000) / 2
    expect(s.avgIncome).toBe(50000);
  });
  it('沒有資料的舊月份不送', () => {
    expect(s.months.map((m) => m.label)).toEqual(['2026-08', '2026-09', '2026-10']);
  });
  it('下個月的標籤與天數', () => {
    expect(s.nextMonth).toEqual({ label: '2026-11', days: 30 });
  });
  it('去識別化：摘要裡沒有備註、帳戶、日期明細', () => {
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/2026-09-10|2026-08-25|note|account|merchant/i);
  });
  it('分類超過 10 個時，其餘合併', () => {
    const many: SummaryInput['cats'] = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, name: `分類${i}`, kind: 'expense' as const, parentId: '' }));
    const r = buildFinanceSummary({ ...base(many.map((c, i) => tx('2026-09-10', 1000 - i, 'expense', c.id))), cats: many });
    const sep = r.months.find((m) => m.label === '2026-09')!;
    expect(Object.keys(sep.byCategory)).toHaveLength(11);
    expect(sep.byCategory['其餘分類']).toBe(1000 - 10 + 1000 - 11 + 1000 - 12);
  });
  it('固定支出、預算、目標、淨資產都換成整數元', () => {
    const r = buildFinanceSummary({ ...base([]), fixed: { subscriptions: 39900, installments: 100000, loans: 0, otherRecurring: 0 }, budgets: [{ name: '飲食預算', limit: 1000000, spent: 250050 }],
      goals: [{ name: '旅行', target: 5000000, saved: 1250000, deadline: '2027-03-01' }], netWorth: 123456789 });
    expect(r.fixedMonthly).toEqual({ total: 1399, subscriptions: 399, installments: 1000, loans: 0, otherRecurring: 0 });
    expect(r.budgets[0]).toEqual({ name: '飲食預算', limit: 10000, spent: 2501 });
    expect(r.goals[0]).toEqual({ name: '旅行', target: 50000, saved: 12500, deadline: '2027-03-01' });
    expect(r.netWorth).toBe(1234568);
  });
  it('日幣（0 位小數）不再除 100', () => {
    const r = buildFinanceSummary({ ...base([{ date: '2026-09-10', type: 'expense', categoryId: 'food', amount: 5000 }]), decimals: 0, currency: 'JPY' });
    expect(r.months.find((m) => m.label === '2026-09')!.expense).toBe(5000);
  });
});

describe('monthlyFixed', () => {
  it('訂閱／週期依頻率換算月；分期取下一期；只算支出', () => {
    const f = monthlyFixed([
      { active: 1, kind: 'subscription', template: { type: 'expense', amountMinor: 39900 }, rule: { freq: 'month', interval: 1 } },
      { active: 1, kind: 'subscription', template: { type: 'expense', baseAmountMinor: 120000 }, rule: { freq: 'year', interval: 1 } },
      { active: 1, kind: 'normal', template: { type: 'expense', amountMinor: 1500000 }, rule: { freq: 'month', interval: 1 } },
      { active: 1, kind: 'normal', template: { type: 'income', amountMinor: 5000000 }, rule: { freq: 'month', interval: 1 } },
      { active: 0, kind: 'normal', template: { type: 'expense', amountMinor: 999 }, rule: { freq: 'month', interval: 1 } },
    ] as never, [
      { status: 'active', schedule: [{ no: 1, date: '2026-09-01', principalMinor: 1, interestMinor: 1, feeMinor: 1, transactionId: 't' }, { no: 2, date: '2026-11-01', principalMinor: 800, interestMinor: 100, feeMinor: 50 }] },
      { status: 'done', schedule: [{ no: 1, date: '2026-11-01', principalMinor: 9999, interestMinor: 0, feeMinor: 0 }] },
    ], [300000], '2026-10-15');
    expect(f).toEqual({ subscriptions: 39900 + 10000, otherRecurring: 1500000, installments: 950, loans: 300000 });
  });
});

describe('dailyAllowance', () => {
  it('（總預算 − 固定支出）÷ 天數，不為負', () => {
    expect(dailyAllowance(45000, 15000, 30)).toBe(1000);
    expect(dailyAllowance(10000, 15000, 30)).toBe(0);
    expect(dailyAllowance(45000, 0, 0)).toBe(0);
  });
});

describe('planToBudgetInputs', () => {
  const plan = { total: 41500, categories: [{ name: '飲食', amount: 9500 }, { name: '交通', amount: 2000 }, { name: '不存在', amount: 1 }, { name: '午餐', amount: 100 }] };
  it('名稱對回分類 id，金額轉最小單位', () => {
    const r = planToBudgetInputs(plan, cats, [], 2);
    expect(r.items).toEqual([
      { name: '每月總預算', categoryId: '', amountMinor: 4150000 },
      { name: '飲食預算', categoryId: 'food', amountMinor: 950000 },
      { name: '交通預算', categoryId: 'taxi', amountMinor: 200000 },
      { name: '午餐預算', categoryId: 'lunch', amountMinor: 10000 },
    ]);
    expect(r.skipped).toEqual(['不存在']);
  });
  it('已經有的月預算不重複建立；停用的不算', () => {
    const r = planToBudgetInputs(plan, cats, [
      { categoryId: '', periodType: 'month', projectId: '', active: 1 }, { categoryId: 'food', periodType: 'month', projectId: '', active: 1 }, { categoryId: 'taxi', periodType: 'month', projectId: '', active: 0 },
    ], 2);
    expect(r.items.map((i) => i.categoryId)).toEqual(['taxi', 'lunch']);
    expect(r.skipped).toEqual(['總預算', '飲食', '不存在']);
  });
});

describe('periodToAi', () => {
  it('只含分類層級統計，沒有備註與日期', () => {
    const catMap = new Map<string, Category>([['food', { id: 'food', name: '飲食' } as Category]]);
    const sum = { expense: 1234500, income: 0, prevExpense: 1000000, prevIncome: 0, changePct: 23.45, count: 12, noSpendDays: 4, elapsedDays: 30, dailyAvg: 41150,
      categories: [{ id: 'food', amount: 900000, prev: 700000, delta: 200000 }], biggest: { categoryId: 'food', baseAmountMinor: 300000, note: '機密備註', date: '2026-09-09' } } as unknown as PeriodSummary;
    const r = periodToAi(sum, catMap, '2026 年 9 月', 'TWD', 2);
    expect(r).toMatchObject({ expense: 12345, prevExpense: 10000, changePct: 23, categories: [{ name: '飲食', amount: 9000, prev: 7000 }], biggestSingle: { category: '飲食', amount: 3000 } });
    expect(JSON.stringify(r)).not.toMatch(/機密備註|2026-09-09/);
  });
});

describe('hashJson', () => {
  it('相同內容同雜湊、不同內容不同', () => {
    expect(hashJson({ a: 1, b: [1, 2] })).toBe(hashJson({ a: 1, b: [1, 2] }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });
});

import { accountToAi, projectToAi } from '@/domain/aisummary';

describe('projectToAi / accountToAi', () => {
  it('專案：分類併到主分類、預算使用率、每日平均；不含備註', () => {
    const r = projectToAi({
      name: '日本旅行', currency: 'JPY', decimals: 0, start: '2026-10-01', end: '2026-10-05', today: '2026-10-28', budgetMinor: 100000,
      expense: 80000, income: 0, byCat: new Map([['lunch', 30000], ['food', 10000], ['taxi', 40000]]), byDay: new Map([['2026-10-01', 50000], ['2026-10-02', 30000]]), cats,
    });
    expect(r).toMatchObject({ name: '日本旅行', days: 5, budget: 100000, expense: 80000, budgetUsedPct: 80, dailyAvg: 16000, maxDay: 50000, spendDays: 2 });
    expect(r.byCategory).toEqual({ 交通: 40000, 飲食: 40000 });
    expect(JSON.stringify(r)).not.toMatch(/note|備註|merchant/i);
  });
  it('專案沒有結束日、沒有預算：以今天計天數', () => {
    const r = projectToAi({ name: 'x', currency: 'TWD', decimals: 2, start: '2026-10-20', today: '2026-10-28', expense: 90000, income: 0, byCat: new Map(), byDay: new Map(), cats });
    expect(r).toMatchObject({ days: 9, budget: null, budgetUsedPct: null, end: null, expense: 900 });
  });
  it('信用卡帳戶：欠款、額度使用率、近 3 個月、主要分類', () => {
    const r = accountToAi({
      name: '玉山卡', typeLabel: '信用卡', currency: 'TWD', decimals: 2, balanceMinor: -3000000, isDebt: true, creditLimitMinor: 10000000, today: '2026-10-15',
      txs: [{ date: '2026-09-10', type: 'expense', categoryId: 'lunch', amountMinor: 500000 }, { date: '2026-10-05', type: 'expense', categoryId: 'taxi', amountMinor: 200000 }, { date: '2026-10-06', type: 'income', categoryId: 'salary', amountMinor: 100000 }], cats,
    });
    expect(r).toMatchObject({ name: '玉山卡', owed: 30000, creditLimit: 100000, creditUsedPct: 30, txCount: 3 });
    expect(r.months.map((m) => [m.label, m.expense, m.income])).toEqual([['2026-08', 0, 0], ['2026-09', 5000, 0], ['2026-10', 2000, 1000]]);
    expect(r.topExpenseCategories).toEqual({ 飲食: 5000, 交通: 2000 });
  });
  it('一般帳戶用 balance', () => {
    const r = accountToAi({ name: '錢包', typeLabel: '現金', currency: 'TWD', decimals: 2, balanceMinor: 123400, isDebt: false, today: '2026-10-15', txs: [], cats });
    expect(r).toMatchObject({ balance: 1234 });
    expect('owed' in r).toBe(false);
  });
});

/**
 * v1.3：一句話記帳（補分類與帳戶、一次記多筆）、收件匣解析、現金流預測、週報／月報、用問的查帳
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { bootstrap } from '@/db/bootstrap';
import { addAccount } from '@/db/repo/accounts';
import { invalidateAutocat, saveRule } from '@/services/autocat';
import { forecast, dailyVariableSpend } from '@/domain/cashflow';
import { summarize } from '@/domain/summary';
import { parseQuery, type QueryContext } from '@/domain/nlquery';
import { itemDate, noticeMerchant } from '@/services/inbox';
import type { Category, Transaction } from '@/db/types';

async function fresh() {
  await db.delete();
  await db.open();
  await bootstrap();
  invalidateAutocat();
  const { useSettings } = await import('@/stores/settings');
  const { DEFAULT_SETTINGS } = await import('@/db/repo/settings');
  // 測試環境沒有 document：set() 只更新狀態，不套用主題
  useSettings.setState({ ...DEFAULT_SETTINGS, set: ((k: string, v: unknown) => useSettings.setState({ [k]: v })) as never });
}

const acc = (name: string, type: 'cash' | 'bank' | 'credit' = 'bank') =>
  addAccount({ name, type, currency: 'TWD', icon: '🏦', color: '#000', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: type === 'credit' });

describe('一句話記帳：補分類、帳戶並一次記下', () => {
  beforeEach(fresh);
  it('文字寫到的帳戶優先；沒寫時用規則指定的帳戶；分類用分類名稱或規則', async () => {
    const esun = await acc('玉山銀行');
    const pay = await acc('全支付');
    await saveRule({ keyword: '全聯', match: 'contains', kind: 'expense', categoryId: 'exp-shopping-daily', accountId: pay.id, priority: 100, enabled: true });
    const { draftsFromText, bookDrafts } = await import('@/services/quickentry');
    const list = await draftsFromText('昨天午餐 150 刷玉山卡，全聯 356');
    expect(list.map((d) => [d.amount, d.categoryId, d.accountId])).toEqual([
      [150, 'exp-food-lunch', esun.id], [356, 'exp-shopping-daily', pay.id],
    ]);
    const r = await bookDrafts(list);
    expect(r.txIds).toHaveLength(2);
    expect((await db.accounts.get(esun.id))!.balanceMinor).toBe(-15000);
    expect((await db.accounts.get(pay.id))!.balanceMinor).toBe(-35600);
  });
});

describe('收件匣解析', () => {
  beforeEach(fresh);
  it('Apple Pay：金額字串、卡片對應帳戶、商家帶入分類', async () => {
    const esun = await acc('玉山銀行');
    await acc('錢包', 'cash');
    const { draftsFromItem } = await import('@/services/inbox');
    const { parseContext } = await import('@/services/quickentry');
    const ctx = await parseContext('2026-10-28');
    const item = { id: 1, source: 'applepay' as const, text: '', amount: 'NT$1,234.00', merchant: '全聯福利中心', card: '玉山 Pi 卡', occurred: '', created_at: '2026-10-28T04:00:00' };
    const [d] = await draftsFromItem(item, ctx, 'fallback');
    expect(d).toMatchObject({ kind: 'expense', amount: 1234, accountId: esun.id, note: '全聯福利中心', date: '2026-10-28' });
  });
  it('簡訊：取 NT$ 金額（不是卡號末四碼）、商店名稱', async () => {
    await acc('玉山銀行');
    const { draftsFromItem } = await import('@/services/inbox');
    const { parseContext } = await import('@/services/quickentry');
    const ctx = await parseContext('2026-10-28');
    const text = '【玉山銀行】您的信用卡末四碼1234於10/27 12:30消費NT$560，商店:全家便利商店，如有疑問請洽客服';
    const [d] = await draftsFromItem({ id: 2, source: 'sms', text, amount: '', merchant: '', card: '', occurred: '', created_at: '2026-10-28T04:00:00' }, ctx, 'fb');
    expect(d).toMatchObject({ amount: 560, note: '全家便利商店', date: '2026-10-27' });
    expect(noticeMerchant('您於 Uber 消費 NT$230')).toBe('Uber');
  });
  it('交易時間：捷徑格式或收到時間（UTC）', () => {
    expect(itemDate({ occurred: '2026年10月25日 下午12:30', created_at: '2026-10-28T04:00:00' }, '2026-10-28')).toBe('2026-10-25');
    expect(itemDate({ occurred: '', created_at: '2026-10-27T17:00:00' }, '2026-10-28')).toBe(new Date('2026-10-27T17:00:00Z').toLocaleDateString('sv-SE'));
  });
});

describe('現金流預測', () => {
  it('依日期加減、同天先入帳再扣款、找出最低點與不夠付的帳戶', () => {
    const f = forecast({
      today: '2026-10-28', days: 10, dailySpendBase: 0,
      accounts: [{ id: 'a', name: '玉山', currency: 'TWD', balanceMinor: 1000_00, toBase: 1 }, { id: 'b', name: '台新', currency: 'TWD', balanceMinor: 500_00, toBase: 1 }],
      events: [
        { date: '2026-10-30', accountId: 'a', amountMinor: -1500_00, label: 'CUBE 卡 繳款', kind: 'card' },
        { date: '2026-11-05', accountId: 'b', amountMinor: 50000_00, label: '薪水', kind: 'recurring' },
        { date: '2026-11-05', accountId: 'b', amountMinor: -10000_00, label: '房租', kind: 'recurring' },
      ],
    });
    expect(f.start).toBe(1500_00);
    expect(f.lowest).toEqual({ date: '2026-10-30', total: 0 });
    expect(f.shortfalls).toEqual([{ accountId: 'a', date: '2026-10-30', balanceMinor: -500_00, label: 'CUBE 卡 繳款' }]);
    expect(f.end).toBe(40000_00);
    expect(f.knownIn).toBe(50000_00);
    expect(f.knownOut).toBe(11500_00);
  });
  it('日常花費推估只算不固定的支出', () => {
    const tx = (p: Partial<Transaction>) => ({ type: 'expense', baseAmountMinor: 100_00, ...p });
    expect(dailyVariableSpend([tx({}), tx({ recurringRuleId: 'r' }), tx({ installmentId: 'i' }), tx({ type: 'income' }), tx({})], 2)).toBe(100_00);
  });
});

const cat = (id: string, name: string, parentId = ''): Category => ({ id, name, parentId, kind: 'expense', icon: '', color: '', sort: 0, archived: 0, createdAt: 0, updatedAt: 0 });
const t = (date: string, amount: number, categoryId: string, note = ''): Transaction => ({
  id: `${date}-${amount}-${note}`, type: 'expense', accountId: 'a', categoryId, amountMinor: amount, currency: 'TWD', accountAmountMinor: amount,
  baseAmountMinor: amount, date, ts: new Date(`${date}T12:00:00`).getTime(), note, tagIds: [], attachmentIds: [], createdAt: 0, updatedAt: 0,
});

describe('週報', () => {
  it('和上週比、分類變化、最大一筆、無消費日', () => {
    const cats = new Map([cat('food', '飲食'), cat('dineout', '聚餐', 'food'), cat('tr', '交通')].map((c) => [c.id, c]));
    const cur = [t('2026-10-19', 500_00, 'dineout', '燒肉'), t('2026-10-20', 100_00, 'food'), t('2026-10-21', 50_00, 'tr')];
    const prev = [t('2026-10-13', 200_00, 'food'), t('2026-10-14', 100_00, 'tr')];
    const s = summarize(cur, prev, cats, { start: '2026-10-19', end: '2026-10-25' }, { start: '2026-10-12', end: '2026-10-18' }, '2026-10-28', (v) => `$${v / 100}`, '週');
    expect(s.expense).toBe(650_00);
    expect(Math.round(s.changePct!)).toBe(117);
    expect(s.noSpendDays).toBe(4);
    expect(s.categories[0]).toMatchObject({ id: 'food', amount: 600_00, prev: 200_00, delta: 400_00, topSubId: 'dineout' });
    expect(s.insights).toEqual(['比前一週多花 117%（多了 $350）。', '「飲食」多了 $400，主要是「聚餐」。', '最大一筆：燒肉 $500。', '有 4 天完全沒花錢 🎉']);
  });
});

describe('用問的查帳', () => {
  const ctx: QueryContext = {
    today: '2026-10-28', weekStart: 1, monthStartDay: 1,
    accounts: [{ id: 'esun', name: '玉山銀行', type: 'bank' }],
    categories: [
      { id: 'exp-food', name: '飲食', kind: 'expense', parentId: '' }, { id: 'exp-food-drink', name: '飲料', kind: 'expense', parentId: 'exp-food' },
      { id: 'exp-transport', name: '交通', kind: 'expense', parentId: '' }, { id: 'inc-salary', name: '薪資', kind: 'income', parentId: '' },
    ],
  };
  it.each([
    ['上個月吃飯花多少', { rangeLabel: '上個月', range: { start: '2026-09-01', end: '2026-09-30' }, categoryIds: ['exp-food'], metric: 'sum', kind: 'expense' }],
    ['這週咖啡喝了幾次', { rangeLabel: '這週', range: { start: '2026-10-26', end: '2026-11-01' }, keyword: '咖啡', metric: 'count' }],
    ['今年最大一筆', { rangeLabel: '今年', metric: 'max' }],
    ['上個月錢都花到哪', { metric: 'topCategory' }],
    ['最近 30 天平均每天花多少', { range: { start: '2026-09-29', end: '2026-10-28' }, metric: 'avgDaily' }],
    ['去年收入多少', { rangeLabel: '去年', kind: 'income', metric: 'sum' }],
    ['10月全聯花多少', { range: { start: '2026-10-01', end: '2026-10-31' }, keyword: '全聯' }],
    ['12月在玉山搭車花多少', { range: { start: '2025-12-01', end: '2025-12-31' }, accountIds: ['esun'], categoryIds: ['exp-transport'] }],
  ])('%s', (text, expected) => {
    expect(parseQuery(text, ctx)).toMatchObject(expected);
  });
  it('不是問句就交給一般搜尋', () => {
    expect(parseQuery('Netflix', ctx)).toBeNull();
    expect(parseQuery('120', ctx)).toBeNull();
  });
});

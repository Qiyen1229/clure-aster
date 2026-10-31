import { describe, expect, it } from 'vitest';
import { buildSankey, DEFAULT_ESSENTIAL_MAIN_IDS, type SankeyModel } from '@/domain/sankey';
import { buildDefaultCategories } from '@/db/seed/categories';
import type { Account, Transaction } from '@/db/types';

const cats = new Map(buildDefaultCategories().map((c) => [c.id, c]));
const acc = (id: string, name: string) => ({ id, name, icon: '', color: '', type: 'bank', currency: 'TWD' }) as unknown as Account;
const accounts = new Map([acc('a1', '薪轉'), acc('a2', '現金')].map((a) => [a.id, a]));
let n = 0;
const tx = (type: 'income' | 'expense', categoryId: string, v: number, accountId = 'a1', extra: Partial<Transaction> = {}) =>
  ({ id: `t${n++}`, type, categoryId, accountId, amountMinor: v, baseAmountMinor: v, currency: 'TWD', date: '2026-10-10', ts: 1, tagIds: [], ...extra }) as unknown as Transaction;
const opts = { essentialMainIds: new Set(DEFAULT_ESSENTIAL_MAIN_IDS), depth: 'main' as const };
const val = (m: SankeyModel, s: string, t: string) => m.links.find((l) => l.source === s && l.target === t)?.value ?? 0;
/** 每個節點（除了最左與最右）流入＝流出 */
const conserved = (m: SankeyModel) => {
  for (const nd of m.nodes) {
    const inn = m.links.filter((l) => l.target === nd.id).reduce((s, l) => s + l.value, 0);
    const outt = m.links.filter((l) => l.source === nd.id).reduce((s, l) => s + l.value, 0);
    if (inn && outt) expect(outt).toBe(inn);
  }
};

describe('資金流向桑基圖資料', () => {
  it('收入 → 總收入 → 必要／非必要／淨儲蓄，流量守恆', () => {
    const m = buildSankey([
      tx('income', 'inc-salary-base', 60000), tx('income', 'inc-sidejob', 10000, 'a2'),
      tx('expense', 'exp-food-lunch', 8000), tx('expense', 'exp-housing-rent', 20000), tx('expense', 'exp-entertainment-movie', 2000, 'a2'),
    ], cats, accounts, opts);
    expect(m.income).toBe(70000);
    expect(val(m, 'i:inc-salary', 'pool')).toBe(60000);
    expect(val(m, 'pool', 'g:essential')).toBe(28000);
    expect(val(m, 'pool', 'g:discretionary')).toBe(2000);
    expect(val(m, 'pool', 'g:saving')).toBe(40000);
    expect(val(m, 'g:essential', 'm:exp-housing')).toBe(20000);
    expect(m.saving).toBe(40000);
    expect(m.deficit).toBe(0);
    conserved(m);
  });
  it('支出多於收入：多一條「動用存款」補差額，淨儲蓄為 0', () => {
    const m = buildSankey([tx('income', 'inc-salary-base', 10000), tx('expense', 'exp-shopping-digital', 25000)], cats, accounts, opts);
    expect(m.deficit).toBe(15000);
    expect(m.saving).toBe(0);
    expect(val(m, 'deficit', 'pool')).toBe(15000);
    expect(m.links.some((l) => l.target === 'g:saving')).toBe(false);
    conserved(m);
  });
  it('投資買進、借出還款各成一組；借入算收入來源', () => {
    const m = buildSankey([
      tx('income', 'inc-salary-base', 100000), tx('income', 'sys-debt-in', 5000),
      tx('expense', 'sys-stock-buy', 30000), tx('expense', 'sys-debt-out', 4000), tx('expense', 'exp-food-lunch', 1000),
    ], cats, accounts, opts);
    expect(val(m, 'pool', 'g:investing')).toBe(30000);
    expect(val(m, 'pool', 'g:debt')).toBe(4000);
    expect(m.investing).toBe(30000);
    expect(m.expense).toBe(1000); // 投資與借貸不算消費支出
    expect(m.links.some((l) => l.source === 'i:sys-debt-in')).toBe(true);
    conserved(m);
  });
  it('可自訂必要／非必要；分帳只算我的份額；已排除與餘額調整不計', () => {
    const o = { ...opts, essentialMainIds: new Set(['exp-entertainment']) };
    const m = buildSankey([
      tx('income', 'inc-salary-base', 50000),
      tx('expense', 'exp-entertainment-game', 1000), tx('expense', 'exp-food-dinner', 3000),
      tx('expense', 'exp-food-dinner', 9999, 'a1', { excludeFromStats: true }),
      tx('expense', 'exp-food-dinner', 777, 'a1', { type: 'adjust' } as Partial<Transaction>),
      tx('expense', 'exp-food-dinner', 4000, 'a1', { split: { myShareMinor: 1000 } } as Partial<Transaction>),
    ], cats, accounts, o);
    expect(val(m, 'pool', 'g:essential')).toBe(1000);
    expect(val(m, 'pool', 'g:discretionary')).toBe(4000); // 3000 + 分帳我的 1000
  });
  it('含子分類：每個主分類最多顯示前 N 個，其餘合併；只有一個子分類時不再往下展開', () => {
    const m = buildSankey([
      tx('income', 'inc-salary-base', 100000),
      tx('expense', 'exp-food-breakfast', 100), tx('expense', 'exp-food-lunch', 500), tx('expense', 'exp-food-dinner', 400),
      tx('expense', 'exp-food-snack', 50), tx('expense', 'exp-food-drink', 30), tx('expense', 'exp-food-grocery', 20),
      tx('expense', 'exp-housing-rent', 8000),
    ], cats, accounts, { ...opts, depth: 'sub', topSubs: 3 });
    expect(m.links.filter((l) => l.source === 'm:exp-food').map((l) => l.target).sort()).toEqual(['s:exp-food-breakfast', 's:exp-food-dinner', 's:exp-food-lunch', 's:exp-food:rest']);
    expect(val(m, 'm:exp-food', 's:exp-food:rest')).toBe(100); // 50+30+20
    expect(m.links.some((l) => l.source === 'm:exp-housing')).toBe(false);
    conserved(m);
  });
  it('淨儲蓄依各帳戶本期淨流入分配，加總等於淨儲蓄', () => {
    const m = buildSankey([
      tx('income', 'inc-salary-base', 90000, 'a1'), tx('income', 'inc-sidejob', 30000, 'a2'), tx('expense', 'exp-food-lunch', 20000, 'a1'),
    ], cats, accounts, opts);
    const toAcc = m.links.filter((l) => l.source === 'g:saving');
    expect(toAcc.reduce((s, l) => s + l.value, 0)).toBe(m.saving);
    expect(m.saving).toBe(100000);
    expect(val(m, 'g:saving', 'a:a1')).toBe(70000);
    expect(val(m, 'g:saving', 'a:a2')).toBe(30000);
  });
  it('沒有任何收支時標記為空', () => {
    expect(buildSankey([], cats, accounts, opts).empty).toBe(true);
    expect(buildSankey([tx('expense', 'exp-food-lunch', 500)], cats, accounts, opts).empty).toBe(false); // 只有支出：整段由「動用存款」補上
  });
});

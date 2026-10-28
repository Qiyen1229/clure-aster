/**
 * v2.0.1：全域搜尋——轉帳也要搜得到、金額多種寫法、日期、類型、多條件 AND
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction, addTransfer } from '@/db/repo/ledger';
import { describeTerm, matchItem, parseSearch, dateBounds, isAggregationQuestion, preferPlainSearch, type MatchCtx, type SearchItem } from '@/domain/search';
import { searchLedger } from '@/services/search';
import type { Account, Category, Tag, Transaction, Transfer } from '@/db/types';

const TODAY = '2026-10-28'; // 週三
const p = (s: string) => parseSearch(s, { today: TODAY, weekStart: 1 });

describe('parseSearch：條件解析', () => {
  it.each([
    ['5000', { kind: 'num', value: 5000 }],
    ['5,000', { kind: 'num', value: 5000 }],
    ['$5000', { kind: 'num', value: 5000 }],
    ['NT$5,000', { kind: 'num', value: 5000 }],
    ['5000元', { kind: 'num', value: 5000 }],
    ['５０００', { kind: 'num', value: 5000 }], // 全形
    ['12.5', { kind: 'num', value: 12.5 }],
  ])('單一金額 %s', (s, t) => expect(p(s).terms).toEqual([expect.objectContaining(t)]));

  it.each([
    ['1000-5000', 1000, 5000], ['1000~5000', 1000, 5000], ['5000到1000', 1000, 5000], ['>=5000', 5000, Infinity], ['5000以上', 5000, Infinity],
    ['<=300', 0, 300], ['300以下', 0, 300], ['超過1,000', 1000.01, Infinity], ['低於100', 0, 99.99],
  ])('金額範圍 %s', (s, min, max) => expect(p(s).terms).toEqual([expect.objectContaining({ kind: 'range', min, max })]));

  it.each([
    ['2026-10-25', { kind: 'date', start: '2026-10-25', end: '2026-10-25' }],
    ['2026/10/5', { kind: 'date', start: '2026-10-05', end: '2026-10-05' }],
    ['2026年10月25日', { kind: 'date', start: '2026-10-25', end: '2026-10-25' }],
    ['2026-10', { kind: 'date', start: '2026-10-01', end: '2026-10-31' }],
    ['2026年2月', { kind: 'date', start: '2026-02-01', end: '2026-02-28' }],
    ['10/25', { kind: 'md', month: 10, day: 25 }],
    ['10月25日', { kind: 'md', month: 10, day: 25 }],
    ['10月25號', { kind: 'md', month: 10, day: 25 }],
    ['10月', { kind: 'month', month: 10 }],
    ['今天', { kind: 'date', start: TODAY, end: TODAY }],
    ['昨天', { kind: 'date', start: '2026-10-27', end: '2026-10-27' }],
    ['前天', { kind: 'date', start: '2026-10-26', end: '2026-10-26' }],
    ['最近', { kind: 'date', start: '2026-10-22', end: TODAY }],
    ['本週', { kind: 'date', start: '2026-10-26', end: '2026-11-01' }],
    ['上週', { kind: 'date', start: '2026-10-19', end: '2026-10-25' }],
    ['本月', { kind: 'date', start: '2026-10-01', end: '2026-10-31' }],
    ['上個月', { kind: 'date', start: '2026-09-01', end: '2026-09-30' }],
    ['今年', { kind: 'date', start: '2026-01-01', end: '2026-12-31' }],
    ['去年', { kind: 'date', start: '2025-01-01', end: '2025-12-31' }],
  ])('日期 %s', (s, t) => expect(p(s).terms).toEqual([expect.objectContaining(t)]));

  it('不合理的日期當成文字／金額，不會變成錯誤的日期', () => {
    expect(p('13/45').terms[0].kind).toBe('text');
    expect(p('2026-02-30').terms[0].kind).toBe('text');
    expect(p('13月').terms[0].kind).toBe('text');
    expect(p('1000-5000').terms[0].kind).toBe('range'); // 不是日期
    expect(p('2/29').terms[0]).toMatchObject({ kind: 'md', month: 2, day: 29 });
  });

  it('類型、標籤、帳戶、文字、多條件', () => {
    expect(p('轉帳').terms).toEqual([{ kind: 'type', value: 'transfer' }]);
    expect(p('#旅遊 @玉山').terms).toEqual([{ kind: 'tag', value: '旅遊' }, { kind: 'account', value: '玉山' }]);
    expect(p('  麥當勞   10/25  5000 ').terms.map((t) => t.kind)).toEqual(['text', 'md', 'num']);
    expect(p('').terms).toEqual([]);
    expect(p('Netflix').terms).toEqual([{ kind: 'text', value: 'netflix' }]);
  });

  it('dateBounds：多個日期條件取交集；M/D 不限縮範圍', () => {
    expect(dateBounds(p('2026-10 本週'))).toEqual({ start: '2026-10-26', end: '2026-10-31' });
    expect(dateBounds(p('10/25'))).toEqual({});
    expect(dateBounds(p('午餐'))).toEqual({});
  });

  it('describeTerm', () => {
    expect(p('5000 轉帳 上週').terms.map(describeTerm)).toEqual(['💰 5000', '🏷 轉帳', '📅 上週']);
  });
});

// ── matchItem（純函式，不碰資料庫）──
const cats = new Map<string, Category>([
  ['food', { id: 'food', name: '飲食', parentId: '', kind: 'expense' } as Category],
  ['lunch', { id: 'lunch', name: '午餐', parentId: 'food', kind: 'expense' } as Category],
]);
const accounts = new Map<string, Account>([
  ['a1', { id: 'a1', name: '玉山銀行', currency: 'TWD' } as Account],
  ['a2', { id: 'a2', name: '錢包', currency: 'TWD' } as Account],
  ['usd', { id: 'usd', name: 'Wise 美元', currency: 'USD' } as Account],
]);
const tags = new Map<string, Tag>([['t1', { id: 't1', name: '旅遊' } as Tag]]);
const ctx: MatchCtx = { cats, accounts, tags, baseCurrency: 'TWD' };
const tx = (o: Partial<Transaction>): SearchItem => ({ kind: 'tx', tx: { type: 'expense', accountId: 'a1', categoryId: 'lunch', amountMinor: 15000, accountAmountMinor: 15000, baseAmountMinor: 15000, currency: 'TWD', date: '2026-10-25', note: '', tagIds: [], ...o } as Transaction });
const tr = (o: Partial<Transfer>): SearchItem => ({ kind: 'transfer', tr: { fromAccountId: 'a1', toAccountId: 'a2', fromAmountMinor: 500000, toAmountMinor: 500000, feeMinor: 0, date: '2026-10-25', note: '', tagIds: [], ...o } as Transfer });
const m = (item: SearchItem, s: string) => matchItem(item, p(s), ctx);

describe('matchItem', () => {
  it('★ 轉帳 5000：搜尋 5000／5,000／$5000／5000元 都找得到', () => {
    for (const s of ['5000', '5,000', '$5000', '5000元', '4000-6000', '>=5000', '轉帳', '轉帳 5000', '玉山', '@錢包', '10/25', '10/25 5000 轉帳']) expect(m(tr({}), s), s).toBe(true);
    for (const s of ['5001', '6000-7000', '收入', '午餐', '10/26', '5000 午餐']) expect(m(tr({}), s), s).toBe(false);
  });
  it('轉帳也比對轉入金額（跨幣別）與手續費、備註', () => {
    const t = tr({ fromAccountId: 'a1', toAccountId: 'usd', fromAmountMinor: 320000, toAmountMinor: 10000, feeMinor: 3000, note: '匯給房東' });
    expect(m(t, '3200')).toBe(true);
    expect(m(t, '100')).toBe(true); // 轉入 USD 100.00
    expect(m(t, '30')).toBe(true); // 手續費
    expect(m(t, '房東')).toBe(true);
    expect(m(t, 'wise')).toBe(true);
  });
  it('一般帳目：金額、分類（含上層）、帳戶、標籤、備註、類型', () => {
    const t = tx({ note: '麥當勞 薯條', tagIds: ['t1'], merchant: 'McDonald' });
    for (const s of ['150', '150元', '午餐', '飲食', '玉山', '#旅遊', '麥當勞', 'mcdonald', '支出', '10月', '2026-10', '100-200', '麥當勞 150 午餐 10/25']) expect(m(t, s), s).toBe(true);
    for (const s of ['收入', '轉帳', '151', '旅遊2', '麥當勞 午餐 11/25', '@錢包']) expect(m(t, s), s).toBe(false);
  });
  it('數字也比對備註與發票號碼（備註裡有 5000）', () => {
    expect(m(tx({ note: '訂單 5000 號', amountMinor: 100 }), '5000')).toBe(true);
    expect(m(tx({ invoiceNo: 'AB12345678' }), '12345678')).toBe(true);
    expect(m(tx({ note: '訂單 5001 號', amountMinor: 100 }), '5000')).toBe(false);
  });
  it('外幣帳目：原幣、帳戶幣別、主幣別金額都能搜到', () => {
    const t = tx({ accountId: 'usd', currency: 'USD', amountMinor: 10000, accountAmountMinor: 10000, baseAmountMinor: 320000 });
    expect(m(t, '100')).toBe(true);
    expect(m(t, '3200')).toBe(true);
  });
  it('餘額調整的負數也能用絕對值搜到；分帳可搜自己的份額', () => {
    expect(m(tx({ type: 'adjust', amountMinor: -50000, accountAmountMinor: -50000, baseAmountMinor: -50000 }), '500')).toBe(true);
    expect(m(tx({ amountMinor: 30000, accountAmountMinor: 30000, baseAmountMinor: 30000, split: { myShareMinor: 10000, debtIds: [] } }), '100')).toBe(true);
  });
  it('大小寫不拘；全形數字可用', () => {
    expect(m(tx({ note: 'Netflix' }), 'NETFLIX')).toBe(true);
    expect(m(tx({}), '１５０')).toBe(true);
  });
  it('範圍邊界含頭尾', () => {
    expect(m(tx({}), '150-200')).toBe(true);
    expect(m(tx({}), '100-150')).toBe(true);
    expect(m(tx({}), '>150')).toBe(false);
    expect(m(tx({}), '>=150')).toBe(true);
    expect(m(tx({}), '<150')).toBe(false);
    expect(m(tx({}), '<=150')).toBe(true);
  });
});

// ── searchLedger：真的查資料庫（重現「轉帳 5000 搜不到」）──
describe('searchLedger（IndexedDB）', () => {
  let a1: string, a2: string;
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    const mk = (name: string) => addAccount({ name, icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 10_000_000, includeInNetWorth: true, isLiability: false });
    a1 = (await mk('玉山')).id;
    a2 = (await mk('中信')).id;
  });
  const run = async (s: string) => {
    const [accs, cs, ts] = await Promise.all([db.accounts.toArray(), db.categories.toArray(), db.tags.toArray()]);
    const c: MatchCtx = { cats: new Map(cs.map((x) => [x.id, x])), accounts: new Map(accs.map((x) => [x.id, x])), tags: new Map(ts.map((x) => [x.id, x])), baseCurrency: 'TWD' };
    return searchLedger(p(s), c);
  };

  it('★ 前幾天轉帳 5000，搜尋 5000 找得到', async () => {
    await addTransfer({ fromAccountId: a1, toAccountId: a2, fromAmountMinor: 500000, toAmountMinor: 500000, feeMinor: 0, date: '2026-10-25', ts: Date.parse('2026-10-25T10:00:00'), note: '' });
    const r = await run('5000');
    expect(r.items.map((i) => i.kind)).toEqual(['transfer']);
  });

  it('轉帳手續費的附屬列不會重複出現；刪除的不會出現；新到舊排序', async () => {
    const t1 = await addTransfer({ fromAccountId: a1, toAccountId: a2, fromAmountMinor: 500000, toAmountMinor: 500000, feeMinor: 1500, date: '2026-10-20', ts: Date.parse('2026-10-20T10:00:00'), note: '' });
    await addTransaction({ type: 'expense', accountId: a1, categoryId: 'exp-food-lunch', amountMinor: 500000, currency: 'TWD', date: '2026-10-26', ts: Date.parse('2026-10-26T10:00:00'), note: '大餐' });
    const del = await addTransaction({ type: 'expense', accountId: a1, categoryId: 'exp-food-lunch', amountMinor: 500000, currency: 'TWD', date: '2026-10-27', ts: Date.parse('2026-10-27T10:00:00'), note: '已刪' });
    await db.transactions.update(del.id, { deletedAt: Date.now() });
    const r = await run('5000');
    expect(r.items.map((i) => [i.kind, i.date])).toEqual([['tx', '2026-10-26'], ['transfer', '2026-10-20']]);
    expect((await run('15')).items.map((i) => i.kind)).toEqual(['transfer']); // 手續費 15
    expect(t1.feeTransactionId).toBeTruthy();
  });

  it('日期範圍、類型、多條件', async () => {
    await addTransfer({ fromAccountId: a1, toAccountId: a2, fromAmountMinor: 500000, toAmountMinor: 500000, feeMinor: 0, date: '2026-09-10', ts: 1, note: '' });
    await addTransfer({ fromAccountId: a1, toAccountId: a2, fromAmountMinor: 500000, toAmountMinor: 500000, feeMinor: 0, date: '2026-10-10', ts: 2, note: '' });
    expect((await run('5000 2026-09')).items.map((i) => i.date)).toEqual(['2026-09-10']);
    expect((await run('5000 轉帳 上個月')).items.map((i) => i.date)).toEqual(['2026-09-10']);
    expect((await run('5000 10月')).items.map((i) => i.date)).toEqual(['2026-10-10']);
    expect((await run('5000 收入')).items).toEqual([]);
    expect((await run('')).items).toEqual([]);
  });

  it('超過上限時標示 truncated', async () => {
    for (let i = 0; i < 305; i++) await addTransaction({ type: 'expense', accountId: a1, categoryId: 'exp-food-lunch', amountMinor: 100, currency: 'TWD', date: '2026-10-10', ts: i, note: 'x' });
    const r = await run('x');
    expect(r.items).toHaveLength(300);
    expect(r.truncated).toBe(true);
  });
});

describe('preferPlainSearch：有金額又不是統計問法時直接搜尋', () => {
  const t = (s: string) => preferPlainSearch(s, p(s));
  it.each(['5000', '上週 5000', '5000 支出', '5000 轉帳 10/25', '1000-5000 午餐'])('直接搜尋：%s', (s) => expect(t(s)).toBe(true));
  it.each(['上個月吃飯花多少', '這週咖啡喝了幾次', '今年最大一筆', '上週 5000 以上有幾筆', '午餐 上週', '去年收入'])('交給查帳回答：%s', (s) => expect(t(s)).toBe(false));
});

describe('isAggregationQuestion', () => {
  it.each(['上個月吃飯花多少', '這週咖啡喝了幾次', '今年最大一筆', '平均每天花多少', '怎麼存錢？'])('是統計／提問：%s', (s) => expect(isAggregationQuestion(s)).toBe(true));
  it.each(['昨天午餐 120', '午餐 120', '領薪水 5萬2', '早餐 60 午餐 120'])('不是：%s', (s) => expect(isAggregationQuestion(s)).toBe(false));
});

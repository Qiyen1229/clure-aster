import { describe, expect, it } from 'vitest';
import { rankNoteSuggestions, type NoteSourceTx } from '@/domain/notesuggest';

const NOW = Date.parse('2026-10-27T12:00:00');
const DAY = 86_400_000;
let n = 0;
const tx = (note: string, daysAgo: number, over: Partial<NoteSourceTx> = {}): NoteSourceTx => ({
  id: `t${++n}`, type: 'expense', note, amountMinor: 12000, currency: 'TWD', categoryId: 'exp-food', accountId: 'a1', tagIds: [], ts: NOW - daysAgo * DAY, ...over,
});
const opts = { type: 'expense' as const, currency: 'TWD', now: NOW };

describe('最近常記', () => {
  it('依輸入比對備註，常記的排前面', () => {
    const txs = [tx('午餐 便當', 1), tx('午餐 便當', 2), tx('午餐 便當', 3), tx('午茶', 1), tx('晚餐', 1)];
    const r = rankNoteSuggestions(txs, '午', opts);
    expect(r.map((x) => x.note)).toEqual(['午餐 便當', '午茶']);
    expect(r[0].count).toBe(3);
  });
  it('同名備註取最近一次的金額、分類、帳戶', () => {
    const r = rankNoteSuggestions([tx('咖啡', 10, { amountMinor: 5000, categoryId: 'a' }), tx('咖啡', 1, { amountMinor: 6500, categoryId: 'b', accountId: 'a2' })], '咖', opts);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ amountMinor: 6500, categoryId: 'b', accountId: 'a2', count: 2 });
  });
  it('不分大小寫；沒輸入時只列近 90 天', () => {
    expect(rankNoteSuggestions([tx('Uber', 5)], 'uber', opts)).toHaveLength(1);
    const txs = [tx('早餐', 3), tx('去年的東西', 200)];
    expect(rankNoteSuggestions(txs, '', opts).map((x) => x.note)).toEqual(['早餐']);
    expect(rankNoteSuggestions(txs, '去年', opts)).toHaveLength(1);
  });
  it('排除：刪除、其他類型與幣別、轉帳／分期／股票、沒備註或 0 元', () => {
    const txs = [
      tx('a', 1, { deletedAt: 1 }), tx('b', 1, { type: 'income' }), tx('c', 1, { currency: 'USD' }), tx('d', 1, { transferId: 'x' }),
      tx('e', 1, { installmentId: 'x' }), tx('f', 1, { stockTradeId: 'x' }), tx('  ', 1), tx('g', 1, { amountMinor: 0 }), tx('ok', 1),
    ];
    expect(rankNoteSuggestions(txs, '', opts).map((x) => x.note)).toEqual(['ok']);
  });
  it('最多 4 筆（可指定）；開頭符合的優先', () => {
    const txs = ['咖啡 A', 'A 咖啡', '咖啡 B', '咖啡 C', '咖啡 D', '咖啡 E'].map((x) => tx(x, 2));
    expect(rankNoteSuggestions(txs, '咖啡', opts)).toHaveLength(4);
    expect(rankNoteSuggestions(txs, '咖啡', { ...opts, limit: 2 })).toHaveLength(2);
    expect(rankNoteSuggestions(txs, 'a', opts)[0].note.toLowerCase().startsWith('a')).toBe(true);
  });
});

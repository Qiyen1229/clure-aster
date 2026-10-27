import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { computeBudgets, createSuggestedBudgets, suggestBudgets } from '@/db/repo/plan';

let n = 0;
const tx = (date: string, amountMinor: number, categoryId = 'exp-food', over: Record<string, unknown> = {}) => ({
  id: `t${++n}`, type: 'expense', accountId: 'a1', categoryId, amountMinor, baseAmountMinor: amountMinor, accountAmountMinor: amountMinor,
  currency: 'TWD', date, ts: 0, note: '', tagIds: [], attachmentIds: [], createdAt: 0, updatedAt: 0, ...over,
});

describe('預算建議（依過去完整月份）與預估期末', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.budgets.clear();
    await db.categories.clear();
    await db.categories.bulkAdd([
      { id: 'exp-food', kind: 'expense', name: '飲食', icon: '🍜', color: '#f00', sort: 0, system: 0 },
      { id: 'exp-rent', kind: 'expense', name: '居住', icon: '🏠', color: '#00f', sort: 1, system: 0 },
    ] as never);
  });

  it('只看過去 3 個完整月份，依分類彙總', async () => {
    await db.transactions.bulkAdd([
      tx('2026-07-10', 300_000), tx('2026-08-10', 500_000), tx('2026-09-10', 400_000), // 飲食：平均 4,000
      tx('2026-07-01', 1_000_000, 'exp-rent'), tx('2026-08-01', 1_000_000, 'exp-rent'), tx('2026-09-01', 1_000_000, 'exp-rent'),
      tx('2026-10-05', 9_999_999), // 本月：不算
      tx('2026-09-15', 7_777_700, 'sys-debt-out'), // 借貸：不算
      tx('2026-09-16', 5_555_500, 'exp-food', { excludeFromStats: true }), // 不計入統計：不算
    ] as never);
    const s = await suggestBudgets('2026-10-20');
    expect(s.monthsUsed).toBe(3);
    expect(s.total?.avgMinor).toBe(1_400_000);
    expect(s.byCategory.map((x) => x.categoryId)).toEqual(['exp-rent', 'exp-food']);
    expect(s.byCategory[1].suggestion).toMatchObject({ avgMinor: 400_000, suggestedMinor: 450_000 });
  });

  it('沒有歷史帳目 → 沒有建議', async () => {
    const s = await suggestBudgets('2026-10-20');
    expect(s.total).toBeNull();
    expect(s.monthsUsed).toBe(0);
  });

  it('一鍵建立：總預算＋分類，已有的不重複', async () => {
    await db.transactions.bulkAdd([tx('2026-09-10', 400_000), tx('2026-09-01', 1_000_000, 'exp-rent')] as never);
    const s = await suggestBudgets('2026-10-20');
    const ids = await createSuggestedBudgets(s, 'TWD');
    expect(ids).toHaveLength(3);
    expect(await createSuggestedBudgets(s, 'TWD')).toHaveLength(0);
    const total = (await db.budgets.toArray()).find((b) => b.categoryId === '');
    expect(total?.amountMinor).toBe(1_500_000); // 14,000 ×1.05 → 14,700 → 15,000
  });

  it('月初繳房租：依歷史節奏預估，不被平均速度高估', async () => {
    await db.budgets.add({
      id: 'b1', name: '總預算', periodType: 'month', startDate: '2026-07-01', amountMinor: 2_000_000, currency: 'TWD',
      categoryId: '', projectId: '', rollover: false, alertPercents: [80], active: 1, createdAt: 0, updatedAt: 0,
    } as never);
    for (const m of ['2026-07', '2026-08', '2026-09']) {
      await db.transactions.add(tx(`${m}-01`, 1_000_000, 'exp-rent') as never);
      for (let d = 2; d <= 28; d++) await db.transactions.add(tx(`${m}-${String(d).padStart(2, '0')}`, 10_000) as never);
    }
    await db.transactions.add(tx('2026-10-01', 1_000_000, 'exp-rent') as never);
    for (let d = 2; d <= 10; d++) await db.transactions.add(tx(`2026-10-${String(d).padStart(2, '0')}`, 10_000) as never);
    const [v] = await computeBudgets('2026-10-10');
    expect(v.projection.basis).toBe('history');
    // 已花 1,000,000 + 9×10,000；剩 21 天，歷史上之後每天約 10,000（28 日後沒有花費）
    expect(v.projection.projected).toBeLessThan(v.status.projected);
    expect(v.projection.projected).toBeGreaterThan(1_090_000);
    expect(v.projection.projected).toBeLessThan(1_400_000);
  });
});

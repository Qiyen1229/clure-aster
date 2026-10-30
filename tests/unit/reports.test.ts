import { describe, expect, it } from 'vitest';
import { analyze, pctChange } from '@/domain/reports';
import { buildDefaultCategories } from '@/db/seed/categories';
import type { Transaction } from '@/db/types';

const cats = new Map(buildDefaultCategories().map((c) => [c.id, c]));
let n = 0;
const tx = (type: Transaction['type'], categoryId: string, amt: number, date: string, hour = 12, extra: Partial<Transaction> = {}): Transaction => ({
  id: `t${++n}`, type, accountId: 'a', categoryId, amountMinor: amt, currency: 'TWD', accountAmountMinor: amt, baseAmountMinor: amt,
  date, ts: new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`).getTime(), note: '', tagIds: [], attachmentIds: [], createdAt: 0, updatedAt: 0, ...extra,
});

describe('報表分析', () => {
  const txs = [
    tx('expense', 'exp-food-lunch', 15000, '2026-10-05', 12), // 週一
    tx('expense', 'exp-food-dinner', 30000, '2026-10-05', 19),
    tx('expense', 'exp-transport-mrt', 5000, '2026-10-06', 8),
    tx('income', 'inc-salary-base', 100000, '2026-10-05'),
    tx('adjust', 'sys-adjust', -999, '2026-10-06'),
    tx('expense', 'exp-food-dinner', 60000, '2026-10-07', 20, { split: { myShareMinor: 20000, debtIds: [] } }),
  ];
  const a = analyze(txs, cats, { start: '2026-10-01', end: '2026-10-31' }, 'expense', '2026-10-10');
  it('總計、儲蓄率、收支比、日均（只計到今天）', () => {
    expect(a.expense).toBe(70000);
    expect(a.income).toBe(100000);
    expect(a.savingRate).toBe(30);
    expect(a.ratio).toBe(70);
    expect(a.dailyAvg).toBe(7000);
    expect(a.count).toBe(5);
  });
  it('分類下鑽與最大單筆（分帳只算我的份額）', () => {
    expect(a.byMain.get('exp-food')).toBe(65000);
    expect(a.bySub.get('exp-food')!.get('exp-food-dinner')).toBe(50000);
    expect(a.maxTx!.categoryId).toBe('exp-food-dinner');
    expect(a.maxTx!.amountMinor).toBe(30000);
  });
  it('星期與時段', () => {
    expect(a.topWeekday).toBe(1);
    expect(a.topHour).toBe(19);
  });
  it('「最常花錢」看次數，不是金額：週五一筆大額、週二三筆小額 → 週二；早上 8 點三筆小額、晚上 22 點一筆大額 → 8 點', () => {
    const t = [
      tx('expense', 'exp-food-lunch', 900000, '2026-10-09', 22), // 週五，大額一筆
      tx('expense', 'exp-food-lunch', 3000, '2026-10-06', 8), // 週二
      tx('expense', 'exp-food-lunch', 3000, '2026-10-13', 8),
      tx('expense', 'exp-food-lunch', 3000, '2026-10-20', 8),
    ];
    const r = analyze(t, cats, { start: '2026-10-01', end: '2026-10-31' }, 'expense', '2026-10-31');
    expect(r.byWeekday[5]).toBeGreaterThan(r.byWeekday[2]); // 金額上週五較多
    expect(r.topWeekday).toBe(2);
    expect(r.weekdayCount[2]).toBe(3);
    expect(r.topHour).toBe(8);
    expect(r.hourCount[8]).toBe(3);
  });
  it('增減百分比', () => {
    expect(pctChange(120, 100)).toBe(20);
    expect(pctChange(5, 0)).toBeNull();
  });
});

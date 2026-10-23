import { describe, expect, it } from 'vitest';
import { creditAvailability } from '@/domain/creditcard';
import { budgetStatus, todayAllowance } from '@/domain/budget';
import { dividendCalendar } from '@/domain/dividend-calendar';

describe('信用卡可用額度', () => {
  it('總額度 − 目前欠款（已出帳未繳＋未出帳）− 未到期分期本金', () => {
    // 額度 10 萬；欠款 3 萬（其中未出帳 1.2 萬）；分期未到期本金 2.4 萬
    const r = creditAvailability(10000000, -3000000, 1200000, 2400000);
    expect(r).toMatchObject({ owedMinor: 3000000, billedUnpaidMinor: 1800000, unbilledMinor: 1200000, installmentReservedMinor: 2400000, usedMinor: 5400000, availableMinor: 4600000 });
    expect(r.usagePct).toBeCloseTo(54);
  });
  it('溢繳（餘額為正）不佔額度', () => {
    expect(creditAvailability(1000000, 50000, 0, 0).availableMinor).toBe(1000000);
  });
});

describe('動態每日可用（Moze 式）', () => {
  it('今天開始前剩 6,000、剩 30 天 → 今日額度 200；今天花 80 → 還可花 120', () => {
    expect(todayAllowance(600000, 8000, 30)).toEqual({ todayBudget: 20000, todayLeft: 12000, spentToday: 8000 });
  });
  it('今天少花，明天額度自動變多；今天超支，明天變少', () => {
    // 明天：剩 6,000 − 80 = 5,920、剩 29 天 → 204
    expect(todayAllowance(600000 - 8000, 0, 29).todayBudget).toBe(20413);
    // 若今天花 500：明天 5,500 / 29 → 189
    expect(todayAllowance(600000 - 50000, 0, 29).todayBudget).toBe(18965);
    expect(todayAllowance(600000, 50000, 30).todayLeft).toBe(-30000);
  });
  it('budgetStatus 整合：今日額度不受今天花費影響', () => {
    const s = budgetStatus(3000000, 1208000, { start: '2026-10-01', end: '2026-10-31' }, '2026-10-10', 80, 8000);
    // 今天之前已花 12,000 → 剩 18,000，含今天剩 22 天 → 818
    expect(s.todayBudget).toBe(81818);
    expect(s.todayLeft).toBe(81818 - 8000);
  });
});

describe('股利行事曆', () => {
  const holdings = new Map([['s0056', { sharesDec: '2000', currency: 'TWD', exp: 2 }], ['s2330', { sharesDec: '1000', currency: 'TWD', exp: 2 }]]);
  const toBase = (v: number) => v;
  const d = (stockId: string, payDate: string, perShareDec: string, netMinor: number, status: 'paid' | 'announced' = 'paid') =>
    ({ stockId, kind: 'cash' as const, status, payDate, perShareDec, netMinor, grossMinor: status === 'announced' ? 0 : netMinor, currency: 'TWD' });
  const divs = [
    d('s0056', '2025-01-20', '0.7', 70000), d('s0056', '2025-04-20', '0.7', 70000), d('s0056', '2025-07-20', '0.8', 80000), d('s0056', '2025-10-20', '0.9', 90000),
    d('s0056', '2026-01-20', '1', 200000), d('s0056', '2026-04-20', '1', 200000), d('s0056', '2026-07-20', '1', 200000),
    d('s2330', '2026-10-15', '5', 0, 'announced'),
  ];
  const r = dividendCalendar({ year: 2026, today: '2026-10-10', dividends: divs, holdings, toBase });
  it('已領月份加總', () => {
    expect(r.months[0].paidMinor).toBe(200000);
    expect(r.paidMinor).toBe(600000);
  });
  it('未來月份：依去年同月每股股利 × 目前持股推估；已公告者用公告資料', () => {
    expect(r.months[9].items.find((x) => x.stockId === 's0056')).toMatchObject({ kind: 'estimated', amountMinor: 180000 }); // 0.9 × 2000
    expect(r.months[9].items.find((x) => x.stockId === 's2330')).toMatchObject({ kind: 'announced', amountMinor: 500000 }); // 5 × 1000
    expect(r.months[9].projectedMinor).toBe(680000);
  });
  it('已過去的月份不再推估', () => {
    expect(r.months[1].projectedMinor).toBe(0);
  });
});

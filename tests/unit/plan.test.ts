import { describe, expect, it } from 'vitest';
import { describeRule, nextAfter, occurrences, timesPerYear } from '@/domain/recurrence';
import { buildSchedule, periodTotal, remaining } from '@/domain/installment';
import { budgetPeriod, budgetStatus, periodsUntil, rolloverChain } from '@/domain/budget';
import { netByPerson, splitEqually } from '@/domain/debt';
import { goalProgress, monthsBetween } from '@/domain/goal';

describe('週期規則', () => {
  it('每月 31 日：夾到月底 vs 略過', () => {
    expect(occurrences({ freq: 'month', interval: 1, monthEndPolicy: 'clamp' }, '2026-01-31', '2026-01-01', '2026-04-30'))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(occurrences({ freq: 'month', interval: 1, monthEndPolicy: 'skip' }, '2026-01-31', '2026-01-01', '2026-05-31'))
      .toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
  });
  it('每週一、四；每兩週', () => {
    expect(occurrences({ freq: 'week', interval: 1, byWeekday: [1, 4] }, '2026-10-05', '2026-10-01', '2026-10-18'))
      .toEqual(['2026-10-05', '2026-10-08', '2026-10-12', '2026-10-15']);
    expect(occurrences({ freq: 'week', interval: 2, byWeekday: [1, 4] }, '2026-10-05', '2026-10-01', '2026-10-25'))
      .toEqual(['2026-10-05', '2026-10-08', '2026-10-19', '2026-10-22']);
  });
  it('count / until / nextAfter / 每年', () => {
    expect(occurrences({ freq: 'day', interval: 1, count: 3 }, '2026-10-01', '2026-01-01', '2026-12-31')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(occurrences({ freq: 'day', interval: 10, until: '2026-10-25' }, '2026-10-01', '2026-01-01', '2026-12-31')).toEqual(['2026-10-01', '2026-10-11', '2026-10-21']);
    expect(nextAfter({ freq: 'month', interval: 1 }, '2026-01-15', '2026-10-15')).toBe('2026-11-15');
    expect(nextAfter({ freq: 'year', interval: 1 }, '2024-02-29', '2026-01-01')).toBe('2026-02-28');
    expect(nextAfter({ freq: 'day', interval: 1, count: 2 }, '2026-10-01', '2026-10-02')).toBeNull();
  });
  it('年度次數與描述', () => {
    expect(timesPerYear({ freq: 'month', interval: 1 })).toBe(12);
    expect(timesPerYear({ freq: 'year', interval: 1 })).toBe(1);
    expect(describeRule({ freq: 'week', interval: 2, byWeekday: [1, 5] })).toBe('每 2 週 週一、週五');
  });
});

describe('分期', () => {
  it('0 利率平均分攤，總和等於本金', () => {
    const s = buildSchedule({ principalMinor: 10000, periods: 3, aprDec: '0', feeMinor: 0, feeMode: 'first', firstDate: '2026-01-31' });
    expect(s.map((x) => x.principalMinor)).toEqual([3334, 3333, 3333]);
    expect(s.map((x) => x.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });
  it('本息平均攤還（年利率 12%、2 期、本金 10000）', () => {
    const s = buildSchedule({ principalMinor: 10000, periods: 2, aprDec: '12', feeMinor: 0, feeMode: 'first', firstDate: '2026-01-05' });
    expect(s[0]).toMatchObject({ principalMinor: 4975, interestMinor: 100 });
    expect(s[1]).toMatchObject({ principalMinor: 5025, interestMinor: 50 });
    expect(s.reduce((a, x) => a + x.principalMinor, 0)).toBe(10000);
  });
  it('手續費分攤與剩餘負擔', () => {
    const s = buildSchedule({ principalMinor: 12000, periods: 3, aprDec: '0', feeMinor: 100, feeMode: 'spread', firstDate: '2026-01-05' });
    expect(s.map(periodTotal)).toEqual([4034, 4033, 4033]);
    s[0].transactionId = 'x';
    expect(remaining(s)).toEqual({ periodsLeft: 2, futureMinor: 8066 });
  });
});

describe('預算', () => {
  const opts = { monthStartDay: 1, weekStart: 0 as const };
  it('結轉鏈：正結餘加入、超支扣除', () => {
    expect(rolloverChain(1000, [800, 1300, 500], true)).toEqual([{ limit: 1000, carryIn: 0 }, { limit: 1200, carryIn: 200 }, { limit: 900, carryIn: -100 }]);
    expect(rolloverChain(1000, [800, 1300], false).map((x) => x.limit)).toEqual([1000, 1000]);
  });
  it('狀態：剩餘天數、每日可用、推估', () => {
    const st = budgetStatus(30000, 12000, { start: '2026-10-01', end: '2026-10-31' }, '2026-10-10');
    expect(st).toMatchObject({ remaining: 18000, daysLeft: 22, dailyAllowance: 818, projected: 37200, level: 'ok' });
    expect(budgetStatus(1000, 1200, { start: '2026-10-01', end: '2026-10-31' }, '2026-10-10').level).toBe('over');
  });
  it('自訂 14 天週期與期間列舉', () => {
    const b = { periodType: 'custom' as const, customDays: 14, startDate: '2026-09-01', amountMinor: 1, rollover: true };
    expect(budgetPeriod(b, '2026-09-20', opts)).toEqual({ start: '2026-09-15', end: '2026-09-28' });
    expect(periodsUntil({ ...b, periodType: 'month' }, '2026-10-10', opts).map((p) => p.start)).toEqual(['2026-09-01', '2026-10-01']);
  });
});

describe('分帳與目標', () => {
  it('平均拆分總和不變', () => {
    expect(splitEqually(100000, 3)).toEqual([33334, 33333, 33333]);
  });
  it('每人淨額', () => {
    const m = netByPerson([
      { personId: 'a', direction: 'they_owe_me', amountMinor: 500, settled: 0, currency: 'TWD' },
      { personId: 'a', direction: 'i_owe_them', amountMinor: 200, settled: 0, currency: 'TWD' },
      { personId: 'a', direction: 'they_owe_me', amountMinor: 999, settled: 1, currency: 'TWD' },
    ]);
    expect(m.get('a')!.get('TWD')).toBe(300);
  });
  it('每月需存', () => {
    expect(monthsBetween('2026-10-10', '2027-03-31')).toBe(6);
    expect(goalProgress(120000, 30000, '2026-10-10', '2027-03-31')).toMatchObject({ pct: 25, left: 90000, monthly: 15000 });
  });
});

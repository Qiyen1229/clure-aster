import { describe, expect, it } from 'vitest';
import { daysHeld, durableStats, totalDailyBurn, type DurableCalcInput } from '@/domain/durable';

const phone: DurableCalcInput = { costMinor: 36900_00, purchaseDate: '2025-08-01', lifeYears: 3, status: 'active' };

describe('耐用物品每日成本', () => {
  it('持有天數：購入當天算第 1 天、至少 1 天', () => {
    expect(daysHeld('2026-10-31', '2026-10-31')).toBe(1);
    expect(daysHeld('2026-10-01', '2026-10-31')).toBe(31);
    expect(daysHeld('2026-11-01', '2026-10-31')).toBe(1);
    expect(daysHeld('2024-02-28', '2024-03-01')).toBe(3); // 閏年
  });
  it('還在用：每日成本＝購入價 ÷ 持有天數；進度與目標每日成本', () => {
    const s = durableStats(phone, '2026-10-25'); // 2025-08-01 → 2026-10-25 = 451 天
    expect(s.days).toBe(451);
    expect(s.perDayMinor).toBe(Math.round(36900_00 / 451));
    expect(s.lifeDays).toBe(1095);
    expect(s.usedRatio).toBeCloseTo(451 / 1095, 6);
    expect(s.targetPerDayMinor).toBe(Math.round(36900_00 / 1095));
    expect(s.remainingDays).toBe(1095 - 451);
    expect(s.perDayMinor).toBeGreaterThan(s.targetPerDayMinor!); // 還沒用夠本，目前每天比目標貴
  });
  it('再用越久每日成本越低', () => {
    const s = durableStats(phone, '2026-10-25');
    expect(s.perDayAfter!(100)).toBeLessThan(s.perDayMinor);
    expect(s.perDayAfter!(0)).toBe(s.perDayMinor);
    expect(s.perDayAfter!(-50)).toBe(s.perDayMinor); // 負數當 0
  });
  it('賣掉：以處置日為止、扣掉殘值得到真實成本', () => {
    const sold: DurableCalcInput = { ...phone, status: 'sold', endDate: '2027-06-30', saleMinor: 12000_00 };
    const s = durableStats(sold, '2030-01-01'); // today 不影響
    expect(s.days).toBe(daysHeld('2025-08-01', '2027-06-30'));
    expect(s.netCostMinor).toBe(24900_00);
    expect(s.perDayMinor).toBe(Math.round(24900_00 / s.days));
    expect(s.grossPerDayMinor).toBeGreaterThan(s.perDayMinor);
  });
  it('賣得比買得貴：淨成本 0，不會變負數', () => {
    const s = durableStats({ ...phone, status: 'sold', endDate: '2026-01-01', saleMinor: 99999_00 }, '2026-10-25');
    expect(s.netCostMinor).toBe(0);
    expect(s.perDayMinor).toBe(0);
  });
  it('淘汰（沒賣）：以處置日為止、成本不扣殘值', () => {
    const s = durableStats({ ...phone, status: 'retired', endDate: '2026-08-01' }, '2026-10-25');
    expect(s.netCostMinor).toBe(36900_00);
    expect(s.days).toBe(daysHeld('2025-08-01', '2026-08-01'));
  });
  it('每次使用成本：有填次數才有', () => {
    expect(durableStats(phone, '2026-10-25').perUseMinor).toBeUndefined();
    const s = durableStats({ costMinor: 30000_00, purchaseDate: '2026-01-01', status: 'active', uses: 60 }, '2026-10-25');
    expect(s.perUseMinor).toBe(500_00);
    expect(s.lifeDays).toBeUndefined();
  });
  it('合計每天燒多少：只算還在用、同幣別', () => {
    const list = [
      { ...phone, currency: 'TWD' },
      { costMinor: 1000_00, purchaseDate: '2026-10-20', status: 'active' as const, currency: 'TWD' },
      { ...phone, status: 'sold' as const, currency: 'TWD' },
      { ...phone, currency: 'USD' },
    ];
    const total = totalDailyBurn(list, '2026-10-25', 'TWD');
    expect(total).toBe(durableStats(phone, '2026-10-25').perDayMinor + durableStats(list[1], '2026-10-25').perDayMinor);
  });
});

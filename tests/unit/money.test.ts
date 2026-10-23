import { describe, expect, it } from 'vitest';
import { allocate, convertMinor, formatMoney, fromMinor, sumMinor, toMinor } from '@/domain/money';

describe('money', () => {
  it('toMinor 依幣別精度轉整數並四捨五入', () => {
    expect(toMinor('100', 'TWD')).toBe(10000);
    expect(toMinor('0.1', 'TWD') + toMinor('0.2', 'TWD')).toBe(toMinor('0.3', 'TWD'));
    expect(toMinor('1234.565', 'USD')).toBe(123457);
    expect(toMinor('1500', 'JPY')).toBe(1500);
    expect(toMinor('-12.345', 'TWD')).toBe(-1235); // ROUND_HALF_UP 對絕對值進位
  });
  it('fromMinor 還原', () => {
    expect(fromMinor(123456, 'TWD').toString()).toBe('1234.56');
    expect(fromMinor(1500, 'JPY').toString()).toBe('1500');
  });
  it('sumMinor 拒絕超出安全整數', () => {
    expect(sumMinor([1, 2, 3])).toBe(6);
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER, 1])).toThrow();
  });
  it('convertMinor：USD 10.00 × 32.15 = TWD 321.50', () => {
    expect(convertMinor(1000, 'USD', 'TWD', '32.15')).toBe(32150);
    // JPY 1000 × 0.2134 = TWD 213.40
    expect(convertMinor(1000, 'JPY', 'TWD', '0.2134')).toBe(21340);
    expect(convertMinor(500, 'TWD', 'TWD', '99')).toBe(500);
  });
  it('allocate 總和不變（最大餘數法）', () => {
    expect(allocate(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(allocate(100, [1, 1, 1]).reduce((a, b) => a + b)).toBe(100);
    expect(allocate(-100, [1, 2])).toEqual([-33, -67]);
    expect(allocate(1, [1, 1, 1, 1])).toEqual([1, 0, 0, 0]);
  });
  it('formatMoney', () => {
    expect(formatMoney(123456700, 'TWD')).toBe('$1,234,567');
    expect(formatMoney(123450, 'TWD')).toBe('$1,234.50');
    expect(formatMoney(-5000, 'TWD', { sign: 'always' })).toBe('-$50');
    expect(formatMoney(5000, 'TWD', { sign: 'always' })).toBe('+$50');
    expect(formatMoney(1234500, 'TWD', { decimals: 2, thousands: false, symbol: false })).toBe('12345.00');
    expect(formatMoney(3_456_000_00, 'TWD', { compact: true })).toBe('$345.6萬');
    expect(formatMoney(1500, 'JPY', { decimals: 2 })).toBe('¥1,500');
  });
});

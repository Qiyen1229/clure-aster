import { describe, expect, it } from 'vitest';
import { accountingMonth, addMonths, monthGrid, periodRange, shiftPeriod, weekRange } from '@/domain/period';
import { creditCycle } from '@/domain/creditcard';

describe('period', () => {
  it('記帳月起算日', () => {
    expect(accountingMonth('2026-10-10', 1)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(accountingMonth('2026-10-10', 5)).toEqual({ start: '2026-10-05', end: '2026-11-04' });
    expect(accountingMonth('2026-10-03', 5)).toEqual({ start: '2026-09-05', end: '2026-10-04' });
    expect(accountingMonth('2026-01-03', 5)).toEqual({ start: '2025-12-05', end: '2026-01-04' });
    // 起算日 31：二月以月底計
    expect(accountingMonth('2026-02-28', 31)).toEqual({ start: '2026-02-28', end: '2026-03-30' });
  });
  it('週起始日', () => {
    // 2026-10-10 是週六
    expect(weekRange('2026-10-10', 0)).toEqual({ start: '2026-10-04', end: '2026-10-10' });
    expect(weekRange('2026-10-10', 1)).toEqual({ start: '2026-10-05', end: '2026-10-11' });
  });
  it('addMonths 夾到月底', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });
  it('periodRange / shiftPeriod', () => {
    expect(periodRange('2026-10-10', 'year')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(shiftPeriod('2026-10-10', 'week', -1)).toBe('2026-10-03');
  });
  it('monthGrid 2026 年 10 月（週日起始）與截圖一致：首格 9/27、共 42 格', () => {
    const g = monthGrid(2026, 9, 0);
    expect(g).toHaveLength(42);
    expect(g[0]).toMatchObject({ key: '2026-09-27', inMonth: false });
    expect(g[4]).toMatchObject({ key: '2026-10-01', inMonth: true });
    expect(g[41]).toMatchObject({ key: '2026-11-07', inMonth: false });
  });
  it('信用卡帳單週期：結帳 20 日、繳款 5 日', () => {
    const c = creditCycle('2026-10-10', 20, 5);
    expect(c.lastStatement).toEqual({ start: '2026-08-21', end: '2026-09-20' });
    expect(c.current).toEqual({ start: '2026-09-21', end: '2026-10-20' });
    expect(c.dueDate).toBe('2026-10-05');
    const c2 = creditCycle('2026-10-25', 20, 5);
    expect(c2.lastStatement.end).toBe('2026-10-20');
    expect(c2.dueDate).toBe('2026-11-05');
  });
});

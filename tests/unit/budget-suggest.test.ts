import { describe, expect, it } from 'vitest';
import { projectSpend, suggestAmount, suggestBudget } from '@/domain/budget';

const month = (daily: Record<number, number>, days = 30) => Array.from({ length: days }, (_, i) => (daily[i] ?? 0) * 100);

describe('預估期末花費', () => {
  it('沒有歷史：用目前速度', () => {
    expect(projectSpend(30000, 10, 30, [])).toEqual({ projected: 90000, basis: 'pace' });
    expect(projectSpend(30000, 10, 30, [month({})])).toEqual({ projected: 90000, basis: 'pace' });
  });
  it('月初就繳房租：歷史節奏比平均速度準', () => {
    // 每月 1 號房租 10000，之後每天 100
    const m = month(Object.fromEntries([[0, 10000], ...Array.from({ length: 29 }, (_, i) => [i + 1, 100])]));
    const spent = (10000 + 9 * 100) * 100; // 已過 10 天
    const r = projectSpend(spent, 10, 30, [m, m, m]);
    expect(r.basis).toBe('history');
    expect(r.projected).toBe(Math.round(spent + 20 * 100 * 100)); // 剩 20 天 × 100
    // 平均速度會誤判成 32,700
    expect(projectSpend(spent, 10, 30, []).projected).toBeGreaterThan(r.projected);
  });
  it('期間已結束：就是已花', () => {
    expect(projectSpend(50000, 30, 30, [month({ 3: 10 })]).projected).toBe(50000);
  });
  it('歷史期間天數不同（28 天）也能對應', () => {
    const feb = month({ 27: 1000 }, 28); // 月底才有一筆
    const r = projectSpend(0, 14, 30, [feb]);
    expect(r.basis).toBe('history');
    expect(r.projected).toBeGreaterThan(0);
  });
});

describe('預算建議', () => {
  it('進位到好記的整數', () => {
    expect(suggestAmount(423_000)).toBe(450_000); // 4,230 ×1.05 = 4,441 → 4,500
    expect(suggestAmount(95_000)).toBe(100_000); // 950 ×1.05 = 997 → 1,000
    expect(suggestAmount(2_340_000)).toBe(25_000_00); // 23,400 → 24,570 → 25,000
    expect(suggestAmount(0)).toBe(0);
  });
  it('沒花費的月份不納入平均', () => {
    expect(suggestBudget([0, 0, 0])).toBeNull();
    const s = suggestBudget([300_000, 0, 500_000])!;
    expect(s.avgMinor).toBe(400_000);
    expect(s.months).toHaveLength(2);
    expect(s.suggestedMinor).toBe(450_000); // 4,000 ×1.05 = 4,200 → 進位到 500 的倍數 4,500
  });
});

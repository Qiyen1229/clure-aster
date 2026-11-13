// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { tripDayInfo } from '@/features/home/TravelHero';

describe('島嶼假期登機證：tripDayInfo 天數進度', () => {
  const trip = { start: '2026-11-10', end: '2026-11-15' };

  it('出發前顯示倒數天數', () => {
    const info = tripDayInfo(trip, '2026-11-08');
    expect(info.phase).toBe('before');
    expect(info.dayNum).toBe(2);
    expect(info.totalDays).toBe(6);
    expect(info.label).toBe('2 天後出發');
  });

  it('出發當天算第 1 天', () => {
    const info = tripDayInfo(trip, '2026-11-10');
    expect(info.phase).toBe('during');
    expect(info.dayNum).toBe(1);
    expect(info.label).toBe('第 1 天 / 共 6 天');
  });

  it('旅程中顯示第幾天／共幾天', () => {
    const info = tripDayInfo(trip, '2026-11-12');
    expect(info.phase).toBe('during');
    expect(info.dayNum).toBe(3);
    expect(info.totalDays).toBe(6);
    expect(info.label).toBe('第 3 天 / 共 6 天');
  });

  it('未設返程日的旅程沒有總天數', () => {
    const info = tripDayInfo({ start: '2026-11-10' }, '2026-11-12');
    expect(info.phase).toBe('during');
    expect(info.dayNum).toBe(3);
    expect(info.totalDays).toBeNull();
    expect(info.label).toBe('第 3 天');
  });

  it('返程日當天仍在旅程中，隔天標記結束', () => {
    expect(tripDayInfo(trip, '2026-11-15').phase).toBe('during');
    const after = tripDayInfo(trip, '2026-11-16');
    expect(after.phase).toBe('after');
    expect(after.dayNum).toBe(6);
    expect(after.label).toBe('旅程已結束');
  });
});
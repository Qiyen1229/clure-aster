// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/db/types';
import { buildTripDays } from '@/features/home/TravelTimeline';
import { tripAllowance } from '@/features/home/TravelHero';

const tx = (date: string, categoryId: string, type: 'expense' | 'income' = 'expense'): Transaction => ({
  id: `${date}-${categoryId}-${type}`,
  createdAt: 0,
  updatedAt: 0,
  type,
  accountId: 'acc',
  categoryId,
  amountMinor: 100,
  currency: 'JPY',
  accountAmountMinor: 100,
  baseAmountMinor: 21,
  date,
  ts: 0,
  note: '',
  tagIds: [],
  attachmentIds: [],
});

describe('旅程時間軸：buildTripDays', () => {
  const trip = { start: '2026-11-10', end: '2026-11-15' };

  it('行前消費排在旅程前、旅程內逐日編號、今天與未來標記正確', () => {
    const txs = [tx('2026-11-08', 'food'), tx('2026-11-10', 'food'), tx('2026-11-10', 'transport'), tx('2026-11-12', 'hotel')];
    const byDay = new Map([
      ['2026-11-08', 5000],
      ['2026-11-10', 3500],
      ['2026-11-12', 14500],
    ]);
    const days = buildTripDays(trip, txs, byDay, '2026-11-12');
    expect(days.map((d) => d.date)).toEqual([
      '2026-11-08', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15',
    ]);
    expect(days[0]).toMatchObject({ kind: 'pre', dayNum: null, expenseMinor: 5000, txCount: 1 });
    expect(days[1]).toMatchObject({ kind: 'trip', dayNum: 1, expenseMinor: 3500, txCount: 2, catIds: ['food', 'transport'] });
    expect(days[2]).toMatchObject({ dayNum: 2, expenseMinor: 0, txCount: 0, isFuture: false });
    expect(days[3]).toMatchObject({ dayNum: 3, isToday: true, expenseMinor: 14500 });
    expect(days.slice(4).every((d) => d.isFuture && d.dayNum !== null)).toBe(true);
  });

  it('返程未定時範圍延伸到今天；未來已記帳的日期也納入', () => {
    const days = buildTripDays({ start: '2026-11-10' }, [tx('2026-11-14', 'hotel')], new Map(), '2026-11-12');
    expect(days.map((d) => d.date)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    expect(days[4]).toMatchObject({ dayNum: 5, isFuture: true, txCount: 1 });
    expect(days[2].isToday).toBe(true);
  });

  it('返程後的消費標為旅程後、不給天數編號', () => {
    const days = buildTripDays(trip, [tx('2026-11-17', 'food')], new Map(), '2026-11-18');
    const last = days[days.length - 1];
    expect(last).toMatchObject({ date: '2026-11-17', kind: 'post', dayNum: null });
    expect(days).toHaveLength(7);
  });

  it('分類戳章去重、收入不列入戳章；無記帳時仍列出完整旅程', () => {
    const txs = [tx('2026-11-10', 'food'), tx('2026-11-10', 'food'), tx('2026-11-10', 'food', 'income')];
    const days = buildTripDays(trip, txs, new Map([['2026-11-10', 200]]), '2026-11-10');
    expect(days[0].catIds).toEqual(['food']);
    expect(days[0].txCount).toBe(3);
    const empty = buildTripDays(trip, [], new Map(), '2026-11-09');
    expect(empty).toHaveLength(6);
    expect(empty.every((d) => d.expenseMinor === 0 && d.txCount === 0)).toBe(true);
  });
});

describe('登機證每日額度：tripAllowance', () => {
  it('預算÷總天數＝日均；今日未超支回剩餘', () => {
    const a = tripAllowance(80000, 6, 1200);
    expect(a).toEqual({ allowance: 13333, todaySpent: 1200, remaining: 12133, over: false });
  });

  it('今日超支時 over 為 true、remaining 為負', () => {
    const a = tripAllowance(80000, 6, 15000);
    expect(a?.over).toBe(true);
    expect(a?.remaining).toBe(-1667);
  });

  it('無預算或無總天數（返程未定）不顯示額度', () => {
    expect(tripAllowance(undefined, 6, 0)).toBeNull();
    expect(tripAllowance(80000, null, 0)).toBeNull();
    expect(tripAllowance(0, 6, 0)).toBeNull();
  });
});
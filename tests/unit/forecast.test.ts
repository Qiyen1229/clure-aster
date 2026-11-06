import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { useSettings } from '@/stores/settings';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import type { Finding } from '@/domain/anomaly';
import { forecastCharges, GRACE_DAYS, nextChargeDate } from '@/domain/forecast';
import { useInboxCount } from '@/services/inboxCount';
import { bookForecast, loadForecast, registerForecast, skipForecast } from '@/services/forecast';
import { addDays } from '@/domain/period';

const finding = (last: string, period: 'week' | 'month' | 'year' = 'month', over: Partial<Finding> = {}): Finding => ({
  id: 'subscription:netflix', kind: 'subscription', severity: 'info', title: 't', why: 'w', tip: 'p', amountMinor: 33000, date: last, txIds: [],
  subscription: { name: 'Netflix', amountMinor: 33000, period, nextDate: addDays(last, 30), categoryId: 'exp-sub', accountId: 'a1', currency: 'TWD', kind: 'subscription' }, ...over,
});

describe('預計扣款（推算）', () => {
  it('每月是「同一天」而不是 +30 天；月底夾到月底；每年同月同日；每週 +7 天', () => {
    expect(nextChargeDate('2026-10-05', 'month')).toBe('2026-11-05');
    expect(nextChargeDate('2026-01-31', 'month')).toBe('2026-02-28');
    expect(nextChargeDate('2026-03-10', 'year')).toBe('2027-03-10');
    expect(nextChargeDate('2026-11-01', 'week')).toBe('2026-11-08');
  });
  it('預計日當天、之後的寬限天數內才出現；還沒到或過太久都不出現', () => {
    const f = finding('2026-10-05');
    expect(forecastCharges([f], '2026-11-04')).toHaveLength(0);
    expect(forecastCharges([f], '2026-11-05')[0]).toMatchObject({ dueDate: '2026-11-05', lateDays: 0, amountMinor: 33000, name: 'Netflix' });
    expect(forecastCharges([f], '2026-11-07')[0].lateDays).toBe(2);
    expect(forecastCharges([f], addDays('2026-11-05', GRACE_DAYS.month))).toHaveLength(1);
    expect(forecastCharges([f], addDays('2026-11-05', GRACE_DAYS.month + 1))).toHaveLength(0);
  });
  it('略過的那一次不再出現，下一期的是新的 id；只看訂閱類', () => {
    const f = finding('2026-10-05');
    const first = forecastCharges([f], '2026-11-06')[0];
    expect(forecastCharges([f], '2026-11-06', new Set([first.id]))).toHaveLength(0);
    expect(forecastCharges([finding('2026-11-05')], '2026-12-05')[0].id).not.toBe(first.id);
    expect(forecastCharges([finding('2026-10-05', 'month', { kind: 'large', subscription: undefined })], '2026-11-06')).toHaveLength(0);
  });
});

describe('預計扣款（服務）', () => {
  const today = '2026-11-07';
  beforeEach(async () => {
    vi.stubGlobal('document', { documentElement: { dataset: {} }, querySelectorAll: () => [] });
    for (const t of ['transactions', 'recurring_rules', 'categories', 'accounts', 'meta', 'reminders']) await db.table(t).clear();
    await db.categories.bulkAdd([
      { id: 'exp-food', kind: 'expense', name: '飲食', icon: '🍜', color: '#f00', sort: 0, system: 0 },
      { id: 'exp-food-lunch', kind: 'expense', name: '午餐', icon: '🍱', color: '#f00', sort: 0, system: 0, parentId: 'exp-food' },
      { id: 'exp-sub', kind: 'expense', name: '訂閱', icon: '📺', color: '#00f', sort: 1, system: 0 },
    ] as never);
    await db.accounts.add({ id: 'a1', name: '現金', type: 'cash', currency: 'TWD', balanceMinor: 0, initialBalanceMinor: 0, archived: 0, sort: 0, createdAt: 0, updatedAt: 0 } as never);
    useSettings.setState({ ...DEFAULT_SETTINGS, insights: { anomaly: true, budgetWarn: true, dismissed: [] } } as never);
    useInboxCount.getState().setExtra(0);
    let n = 0;
    const row = (date: string, note: string, amount: number, categoryId: string) => ({
      id: `t${++n}`, type: 'expense', accountId: 'a1', categoryId, amountMinor: amount * 100, baseAmountMinor: amount * 100, accountAmountMinor: amount * 100,
      currency: 'TWD', date, ts: new Date(`${date}T12:00:00`).getTime(), note, tagIds: [], attachmentIds: [], createdAt: 0, updatedAt: 0,
    });
    const filler = Array.from({ length: 40 }, (_, i) => row(addDays(today, -(i + 1)), `午餐${i % 4}`, 120 + (i % 3) * 10, 'exp-food-lunch'));
    const netflix = ['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'].map((d) => row(d, 'Netflix', 330, 'exp-sub'));
    await db.transactions.bulkAdd([...filler, ...netflix] as never);
  });

  it('11/5 該扣的 Netflix 出現在預計扣款，並更新收件匣數字', async () => {
    const r = await loadForecast(today);
    expect(r.predicted.map((p) => [p.name, p.dueDate, p.lateDays])).toEqual([['Netflix', '2026-11-05', 2]]);
    expect(useInboxCount.getState().extra).toBe(1);
  });
  it('記帳：日期是預計扣款日、金額沿用；記完這一項就消失（下一期是 12/5）', async () => {
    const p = (await loadForecast(today)).predicted[0];
    const id = await bookForecast(p);
    const t = await db.transactions.get(id);
    expect(t).toMatchObject({ date: '2026-11-05', amountMinor: 33000, note: 'Netflix', accountId: 'a1' });
    expect((await loadForecast(today)).predicted).toHaveLength(0);
    expect(useInboxCount.getState().extra).toBe(0);
  });
  it('略過這一次：記在本機 meta，不再出現', async () => {
    const p = (await loadForecast(today)).predicted[0];
    await skipForecast(p.id);
    expect((await db.meta.get('forecast.skipped'))?.value).toContain(p.id);
    expect((await loadForecast(today)).predicted).toHaveLength(0);
  });
  it('登記成週期：預測消失，這一期變成「週期帳目待確認」', async () => {
    const p = (await loadForecast(today)).predicted[0];
    await registerForecast(p);
    const r = await loadForecast(today);
    expect(r.predicted).toHaveLength(0);
    const rule = await db.recurring_rules.toArray();
    expect(rule).toHaveLength(1);
    expect(rule[0].mode).toBe('confirm');
  });
  it('關掉設定就不推算；帳戶已封存的項目不出現', async () => {
    useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, forecast: false } } as never);
    expect((await loadForecast(today)).predicted).toHaveLength(0);
    useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, forecast: true } } as never);
    await db.accounts.update('a1', { archived: 1 });
    expect((await loadForecast(today)).predicted).toHaveLength(0);
  });
});

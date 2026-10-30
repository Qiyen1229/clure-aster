import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { useSettings } from '@/stores/settings';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { computeInsights, createSubscriptionFrom, dismissFinding, loadSnapshot, runInsights } from '@/services/insights';
import { addDays, todayKey } from '@/domain/period';

let n = 0;
const today = todayKey();
const tx = (date: string, note: string, amount: number, over: Record<string, unknown> = {}) => ({
  id: `t${++n}`, type: 'expense', accountId: 'a1', categoryId: 'exp-food-lunch', amountMinor: amount * 100, baseAmountMinor: amount * 100, accountAmountMinor: amount * 100,
  currency: 'TWD', date, ts: new Date(`${date}T12:00:00`).getTime(), note, tagIds: [], attachmentIds: [], createdAt: 0, updatedAt: 0, ...over,
});
const monthsAgo = (k: number) => { const d = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - k, 5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-05`; };

describe('智慧提醒執行層', () => {
  beforeEach(async () => {
    // settings.set 會套用主題（碰 document）；測試環境沒有 DOM，給一個最小替身
    vi.stubGlobal('document', { documentElement: { dataset: {} }, querySelectorAll: () => [] });
    for (const t of ['transactions', 'recurring_rules', 'budgets', 'categories', 'accounts', 'meta', 'reminders']) await db.table(t).clear();
    await db.categories.bulkAdd([
      { id: 'exp-food', kind: 'expense', name: '飲食', icon: '🍜', color: '#f00', sort: 0, system: 0 },
      { id: 'exp-food-lunch', kind: 'expense', name: '午餐', icon: '🍱', color: '#f00', sort: 0, system: 0, parentId: 'exp-food' },
      { id: 'exp-sub', kind: 'expense', name: '訂閱', icon: '📺', color: '#00f', sort: 1, system: 0 },
    ] as never);
    useSettings.setState({ ...DEFAULT_SETTINGS, insights: { anomaly: true, budgetWarn: true, dismissed: [] } } as never);
    const filler = Array.from({ length: 40 }, (_, i) => tx(addDays(today, -(i + 1)), `午餐${i % 4}`, 120 + (i % 3) * 10));
    const netflix = [3, 2, 1, 0].map((k) => tx(monthsAgo(k), 'Netflix', 330, { categoryId: 'exp-sub' }));
    await db.transactions.bulkAdd([...filler, ...netflix] as never);
  });

  it('偵測到沒登記的訂閱，結果寫入快取；關掉偵測就不算', async () => {
    const s = await computeInsights();
    expect(s.findings.find((f) => f.kind === 'subscription')?.subscription?.name).toBe('Netflix');
    expect((await loadSnapshot())?.findings.length).toBe(s.findings.length);
    useSettings.setState({ insights: { anomaly: false, budgetWarn: false, dismissed: [] } } as never);
    expect(await runInsights()).toBeNull();
  });

  it('快取還新且帳目沒變 → 直接用快取（不重算）；帳目變了就重算', async () => {
    const first = await runInsights({ force: true });
    const again = await runInsights();
    expect(again?.at).toBe(first?.at);
    await db.transactions.add(tx(addDays(today, -1), '新的一筆', 99) as never);
    const third = await runInsights();
    expect(third!.at).toBeGreaterThanOrEqual(first!.at);
    expect(third!.txCount).toBe(first!.txCount + 1);
  });

  it('略過：寫入設定（隨帳號同步）、從快取移除，下次偵測不再出現；最多保留 200 筆', async () => {
    const s = await computeInsights();
    const sub = s.findings.find((f) => f.kind === 'subscription')!;
    await dismissFinding(sub.id);
    expect(useSettings.getState().insights.dismissed).toContain(sub.id);
    expect((await loadSnapshot())!.findings.find((f) => f.id === sub.id)).toBeUndefined();
    expect((await computeInsights()).findings.find((f) => f.id === sub.id)).toBeUndefined();
    useSettings.setState({ insights: { anomaly: true, budgetWarn: true, dismissed: Array.from({ length: 205 }, (_, i) => `x${i}`) } } as never);
    await dismissFinding('last');
    expect(useSettings.getState().insights.dismissed).toHaveLength(200);
    expect(useSettings.getState().insights.dismissed.at(-1)).toBe('last');
  });

  it('「建立為訂閱」：登記成每月訂閱（到期提醒確認），之後不再被當成新訂閱', async () => {
    const f = (await computeInsights()).findings.find((x) => x.kind === 'subscription')!;
    const id = await createSubscriptionFrom(f);
    const rule = await db.recurring_rules.get(id);
    expect(rule).toMatchObject({ kind: 'subscription', name: 'Netflix', mode: 'confirm', rule: { freq: 'month', interval: 1 } });
    expect(rule!.template.amountMinor).toBe(33000);
    expect((await computeInsights()).findings.find((x) => x.kind === 'subscription')).toBeUndefined();
  });

  it('預算預警：照目前速度會超支就列出，並附白話說明', async () => {
    const d = new Date(`${today}T00:00:00`);
    const monthStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    if (today.slice(8) < '05') return; // 月初不預測（程式本來就不判斷），這個測試略過
    await db.budgets.add({ id: 'b1', name: '飲食', periodType: 'month', startDate: monthStart, amountMinor: 100_000, rollover: false, categoryId: 'exp-food', alertPercents: [80], currency: 'TWD', active: 1, createdAt: 0, updatedAt: 0 } as never);
    await db.transactions.add(tx(addDays(today, -1), '大餐', 900, { categoryId: 'exp-food-lunch' }) as never);
    const s = await computeInsights();
    expect(s.warnings.length).toBeGreaterThan(0);
    expect(s.warnings[0].why).toContain('本期額度');
  });
});

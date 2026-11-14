/**
 * v4.1.39 全能助手：15 個新工具的執行層測試。
 * 每個工具都走「預覽 → 執行 → 驗證 → 一鍵還原 → 驗證回原樣」；
 * 草稿 id 串接（同一句話新建分類／帳戶／專案再記帳）、原子性回滾也在這裡驗證。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiState = vi.hoisted(() => ({ items: [] as unknown[], acked: [] as number[] }));
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    api: vi.fn(async (path: string, opts?: { body?: unknown }) => {
      if (path === '/inbox/items') return apiState.items;
      if (path === '/inbox/items/ack') {
        const ids = (opts?.body as { ids: number[] }).ids;
        apiState.acked.push(...ids);
        return { ids };
      }
      throw new Error(`未預期的 API 呼叫：${path}`);
    }),
  };
});

import { db } from '@/db/schema';
import { addAccount } from '@/db/repo/accounts';
import { addDebts, findOrCreatePerson, saveRecurring } from '@/db/repo/plan';
import { addTransaction, addTransfer } from '@/db/repo/ledger';
import { applyPlan, listAgentOps, previewPlan, undoOp } from '@/services/agent';
import { invalidateInboxReadOnly, type InboxRaw } from '@/services/inbox';
import { addDays, todayKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';

const today = todayKey();
const cat = (id: string, name: string, kind = 'expense') => ({ id, name, kind, parentId: '', icon: '', color: '', sort: 0, archived: 0, createdAt: 1, updatedAt: 1 });
const step = (tool: string, args: Record<string, unknown>) => ({ tool, args });
const bal = async (id: string) => (await db.accounts.get(id))!.balanceMinor;

let bank = '', wallet = '', card = '';
beforeEach(async () => {
  await db.delete(); await db.open();
  apiState.items = []; apiState.acked = [];
  invalidateInboxReadOnly();
  useSettings.setState({ ...DEFAULT_SETTINGS, baseCurrency: 'TWD', monthStartDay: 1 } as never);
  await db.categories.bulkAdd([cat('exp-other', '其他'), cat('exp-food', '餐飲'), cat('inc-other_inc', '其他收入', 'income'), cat('inc-dividend', '股利', 'income')] as never);
  bank = (await addAccount({ name: '台新', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 1_000_000, includeInNetWorth: true, isLiability: false })).id;
  wallet = (await addAccount({ name: '錢包', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 50_000, includeInNetWorth: true, isLiability: false })).id;
  card = (await addAccount({ name: '信用卡', icon: '', color: '', type: 'credit', currency: 'TWD', initialBalanceMinor: -3_000_000, includeInNetWorth: true, isLiability: true })).id;
  const now = Date.now();
  await db.stocks.add({ id: 's50', market: 'TWSE', symbol: '0050', name: '元大台灣50', currency: 'TWD', assetType: 'etf', lotSize: 1000, createdAt: now, updatedAt: now } as never);
  await db.price_cache.put({ stockId: 's50', priceDec: '180', prevCloseDec: '179', changeDec: '1', changePctDec: '0.5', marketTime: now, source: 'test', updatedAt: now, isManual: false });
});

describe('建立鏈：同一句話新建分類／帳戶／專案，後面的步驟直接用名稱', () => {
  const plan = [
    step('add_category', { name: '毛孩', kind: 'expense' }),
    step('add_account', { name: '寵物錢包', type: 'cash', initial_balance: 500 }),
    step('add_project', { name: '日本行', is_travel: true, start_date: today }),
    step('add_transaction', { type: 'expense', account: '寵物錢包', category: '毛孩', amount: 120, note: '飼料', project: '日本行' }),
    step('transfer', { from_account: '台新', to_account: '寵物錢包', amount: 200 }),
  ];

  it('預覽不寫入；執行時草稿 id 換成真實 id，記帳與轉帳都接得上', async () => {
    const before = JSON.stringify([await db.categories.count(), await db.accounts.count(), await db.projects.count()]);
    const steps = await previewPlan(plan);
    expect(steps.map((s) => s.preview.blocked)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(steps[3].preview.lines.join('\n')).toContain('歸入專案「日本行」');
    expect(JSON.stringify([await db.categories.count(), await db.accounts.count(), await db.projects.count()])).toBe(before);

    await applyPlan(steps, '寵物_setup');
    const c = (await db.categories.toArray()).find((x) => x.name === '毛孩')!;
    const a = (await db.accounts.toArray()).find((x) => x.name === '寵物錢包')!;
    const p = (await db.projects.toArray()).find((x) => x.name === '日本行')!;
    expect(c.id.startsWith('draft-')).toBe(false);
    expect(a.balanceMinor).toBe(50_000 + 20_000 - 12_000);
    const t = (await db.transactions.toArray())[0];
    expect([t.categoryId, t.accountId, t.projectId]).toEqual([c.id, a.id, p.id]);
    expect((await db.transfers.toArray())[0]).toMatchObject({ fromAccountId: bank, toAccountId: a.id });
    expect(await bal(bank)).toBe(1_000_000 - 20_000);
  });

  it('一鍵還原：帳目、轉帳、專案、帳戶都消失；分類因曾被使用改為封存', async () => {
    const steps = await previewPlan(plan);
    const log = await applyPlan(steps, '寵物_setup');
    const r = await undoOp(log.id);
    expect(r.skipped).toBe(0);
    expect(await bal(bank)).toBe(1_000_000);
    expect((await db.accounts.toArray()).filter((x) => x.name === '寵物錢包').length).toBe(0);
    expect(await db.projects.count()).toBe(0);
    expect((await db.transactions.toArray()).every((t) => t.deletedAt)).toBe(true);
    expect((await db.transfers.toArray()).every((t) => t.deletedAt)).toBe(true);
    const c = (await db.categories.toArray()).find((x) => x.name === '毛孩');
    expect(c === undefined || c.archived === 1).toBe(true);
  });
});

describe('記帳擴充：分帳、標籤、商家、排除旗標', () => {
  it('分帳：全額扣款、差額建應收；標籤自動建立；還原後帳目與欠款復原（標籤保留）', async () => {
    const steps = await previewPlan([step('add_transaction', {
      type: 'expense', account: '台新', category: '餐飲', amount: 500, note: '聚餐', merchant: '海底撈',
      split: { my_share: 300, person: '小明' }, tags: ['聚餐', '測試標籤'], exclude_budget: true, exclude_stats: true,
    })]);
    expect(steps[0].preview.debtsCreated).toBe(1);
    expect(steps[0].preview.lines.join('\n')).toContain('小明 欠我');
    const log = await applyPlan(steps, '分帳');
    const t = (await db.transactions.toArray())[0];
    expect(t.amountMinor).toBe(50_000);
    expect(t.split).toMatchObject({ myShareMinor: 30_000 });
    expect(t.merchant).toBe('海底撈');
    expect([t.excludeFromBudget, t.excludeFromStats]).toEqual([true, true]);
    expect(t.tagIds).toHaveLength(2);
    expect(await db.tags.count()).toBe(2);
    const debt = (await db.debts.toArray())[0];
    expect(debt).toMatchObject({ direction: 'they_owe_me', amountMinor: 20_000, transactionId: t.id });
    expect((await db.people.get(debt.personId))!.name).toBe('小明');
    expect(await bal(bank)).toBe(1_000_000 - 50_000);

    const r = await undoOp(log.id);
    expect(r.skipped).toBe(0);
    expect(await bal(bank)).toBe(1_000_000);
    expect((await db.transactions.toArray())[0].deletedAt).toBeTruthy();
    expect(await db.debts.count()).toBe(0);
    expect(await db.tags.count()).toBe(2); // 標籤建立後不隨還原刪除
  });

  it('改帳：設定標籤／專案／排除旗標，還原後完全回原樣（含清空標籤）', async () => {
    await db.projects.add({ id: 'p1', name: '裝修', icon: '📁', color: '', start: today, currency: 'TWD', status: 'active', createdAt: 1, updatedAt: 1 } as never);
    const t0 = await addTransaction({ type: 'expense', accountId: bank, categoryId: 'exp-food', amountMinor: 10_000, currency: 'TWD', date: today, ts: Date.now(), note: '咖啡', tagIds: [] });
    const steps = await previewPlan([step('edit_transaction', { match: { keywords: ['咖啡'] }, set: { project: '裝修', tags: ['工作'], exclude_budget: true, exclude_stats: true } })]);
    expect(steps[0].preview.blocked).toBeUndefined();
    const log = await applyPlan(steps, '改帳');
    const t1 = (await db.transactions.get(t0.id))!;
    expect(t1.projectId).toBe('p1');
    expect(t1.tagIds).toHaveLength(1);
    expect([t1.excludeFromBudget, t1.excludeFromStats]).toEqual([true, true]);

    expect((await undoOp(log.id)).skipped).toBe(0);
    const t2 = (await db.transactions.get(t0.id))!;
    expect(t2.projectId).toBeUndefined();
    expect(t2.tagIds).toEqual([]);
    expect(t2.excludeFromBudget).toBeFalsy();
    expect(t2.excludeFromStats).toBeFalsy();
    expect(await bal(bank)).toBe(1_000_000 - 10_000);

    // 清空標籤：set.tags = [] 也要能還原
    const steps2 = await previewPlan([step('edit_transaction', { match: { keywords: ['咖啡'] }, set: { tags: ['臨時'] } })]);
    const log2 = await applyPlan(steps2, '加標籤');
    expect((await db.transactions.get(t0.id))!.tagIds).toHaveLength(1);
    const steps3 = await previewPlan([step('edit_transaction', { match: { keywords: ['咖啡'] }, set: { tags: [] } })]);
    const log3 = await applyPlan(steps3, '清空標籤');
    expect((await db.transactions.get(t0.id))!.tagIds).toEqual([]);
    await undoOp(log3.id);
    expect((await db.transactions.get(t0.id))!.tagIds).toHaveLength(1);
    // log2 執行後這筆又被 log3 動過（含 log3 的還原）：時間戳不同，安全機制會跳過不蓋掉
    expect((await undoOp(log2.id)).skipped).toBe(1);
    expect((await db.transactions.get(t0.id))!.tagIds).toHaveLength(1);
  });
});

describe('分期付款', () => {
  it('建立分期：已到期期數立刻入帳；還原後分期與帳目都消失、餘額回原樣', async () => {
    const steps = await previewPlan([step('add_installment', { name: '手機', account: '信用卡', amount: 12000, periods: 12, first_date: today })]);
    expect(steps[0].preview.blocked).toBeUndefined();
    expect(steps[0].preview.lines.join('\n')).toContain('已到期的 1 期會立刻入帳');
    const log = await applyPlan(steps, '分期');
    const inst = (await db.installments.toArray())[0];
    expect(inst).toMatchObject({ name: '手機', periods: 12, principalMinor: 1_200_000 });
    const first = inst.schedule[0];
    expect(first.transactionId).toBe(`inst-${inst.id}-1`);
    expect((await db.transactions.get(first.transactionId!))!.amountMinor).toBe(100_000);
    expect(await bal(card)).toBe(-3_000_000 - 100_000);

    expect((await undoOp(log.id)).skipped).toBe(0);
    expect(await db.installments.count()).toBe(0);
    expect((await db.transactions.get(first.transactionId!))!.deletedAt).toBeTruthy();
    expect(await bal(card)).toBe(-3_000_000);
  });

  it('擋下不合理期數與外幣帳戶', async () => {
    await addAccount({ name: '美元戶', icon: '', color: '', type: 'bank', currency: 'USD', initialBalanceMinor: 100_00, includeInNetWorth: true, isLiability: false });
    const steps = await previewPlan([
      step('add_installment', { name: '手機', account: '信用卡', amount: 12000, periods: 1 }),
      step('add_installment', { name: '手機', account: '美元戶', amount: 12000, periods: 12 }),
    ]);
    expect(steps[0].preview.blocked).toContain('2 到 60');
    expect(steps[1].preview.blocked).toContain('外幣');
  });
});

describe('週期帳目管理', () => {
  let ruleId = '';
  beforeEach(async () => {
    ruleId = await saveRecurring({
      kind: 'subscription', name: 'Netflix',
      template: { type: 'expense', accountId: bank, categoryId: 'exp-other', amountMinor: 39_000, currency: 'TWD', note: 'Netflix' },
      rule: { freq: 'month', interval: 1, byMonthDay: 1 },
      startDate: '2026-09-01', mode: 'confirm', remindDaysBefore: 0, active: 1,
      subscription: { service: 'Netflix', priceHistory: [] },
    });
    await db.recurring_rules.update(ruleId, { pendingDates: ['2026-11-01'], nextDue: '2026-12-01' });
  });

  it('確認這期（改金額）：入帳、價格歷史記住；還原後期數回到待確認', async () => {
    const steps = await previewPlan([step('manage_recurring', { name: 'Netflix', action: 'confirm', date: '2026-11-01', amount: 450 })]);
    expect(steps[0].preview.blocked).toBeUndefined();
    const log = await applyPlan(steps, '確認 Netflix');
    const t = (await db.transactions.get(`rec-${ruleId}-2026-11-01`))!;
    expect(t.amountMinor).toBe(45_000);
    const r = (await db.recurring_rules.get(ruleId))!;
    expect(r.pendingDates).toEqual([]);
    expect(r.template.amountMinor).toBe(45_000);
    expect(r.subscription!.priceHistory.length).toBeGreaterThan(0);
    expect(await bal(bank)).toBe(1_000_000 - 45_000);

    expect((await undoOp(log.id)).skipped).toBe(0);
    expect((await db.transactions.get(`rec-${ruleId}-2026-11-01`))!.deletedAt).toBeTruthy();
    const r2 = (await db.recurring_rules.get(ruleId))!;
    expect(r2.pendingDates).toEqual(['2026-11-01']);
    expect(r2.template.amountMinor).toBe(39_000);
    expect(await bal(bank)).toBe(1_000_000);
  });

  it('略過、暫停、恢復：每一步都能還原', async () => {
    const skip = await previewPlan([step('manage_recurring', { name: 'Netflix', action: 'skip', date: '2026-11-01' })]);
    const l1 = await applyPlan(skip, '略過');
    expect((await db.recurring_rules.get(ruleId))!.pendingDates).toEqual([]);
    await undoOp(l1.id);
    expect((await db.recurring_rules.get(ruleId))!.pendingDates).toEqual(['2026-11-01']);

    const pr = await previewPlan([
      step('manage_recurring', { name: 'Netflix', action: 'pause' }),
      step('manage_recurring', { name: 'Netflix', action: 'resume' }),
    ]);
    expect(pr.map((s) => s.preview.blocked)).toEqual([undefined, undefined]);
    const l2 = await applyPlan(pr, '暫停恢復');
    expect((await db.recurring_rules.get(ruleId))!.active).toBe(1);
    await undoOp(l2.id);
    expect((await db.recurring_rules.get(ruleId))!.active).toBe(1);
  });

  it('修改金額／每月幾號／入帳模式；還原後規則回原樣', async () => {
    const steps = await previewPlan([step('manage_recurring', { name: 'Netflix', action: 'edit', amount: 300, day: 15, mode: 'auto' })]);
    expect(steps[0].preview.lines.join('\n')).toContain('改成自動入帳');
    const log = await applyPlan(steps, '改訂閱');
    const r = (await db.recurring_rules.get(ruleId))!;
    expect(r.template.amountMinor).toBe(30_000);
    expect(r.rule.byMonthDay).toBe(15);
    expect(r.mode).toBe('auto');
    expect((await undoOp(log.id)).skipped).toBe(0);
    const r2 = (await db.recurring_rules.get(ruleId))!;
    expect(r2.template.amountMinor).toBe(39_000);
    expect(r2.rule.byMonthDay).toBe(1);
    expect(r2.mode).toBe('confirm');
    expect(r2.nextDue).toBe('2026-12-01');
  });

  it('刪除週期帳目（硬刪除）；還原後整條規則救回', async () => {
    const steps = await previewPlan([step('manage_recurring', { name: 'Netflix', action: 'delete' })]);
    const log = await applyPlan(steps, '刪訂閱');
    expect(await db.recurring_rules.get(ruleId)).toBeUndefined();
    expect((await undoOp(log.id)).skipped).toBe(0);
    expect((await db.recurring_rules.get(ruleId))!.name).toBe('Netflix');
  });

  it('擋下：找不到名稱、沒有待確認期數、已暫停再暫停', async () => {
    const steps = await previewPlan([
      step('manage_recurring', { name: '不存在', action: 'pause' }),
      step('manage_recurring', { name: 'Netflix', action: 'confirm', date: '2026-10-01' }),
      step('manage_recurring', { name: 'Netflix', action: 'edit' }),
    ]);
    expect(steps[0].preview.blocked).toContain('找不到');
    expect(steps[1].preview.blocked).toContain('沒有 2026-10-01 這期');
    expect(steps[2].preview.blocked).toContain('請說明要改什麼');
  });
});

describe('旅遊模式', () => {
  it('建立旅遊專案＋切換＋記帳同一包：帳目自動歸入、設定同步；還原後切回一般模式', async () => {
    const steps = await previewPlan([
      step('add_project', { name: '沖繩', is_travel: true }),
      step('set_travel_mode', { project: '沖繩' }),
      step('add_transaction', { type: 'expense', account: '台新', category: '餐飲', amount: 100, note: '午餐' }),
    ]);
    expect(steps.map((s) => s.preview.blocked)).toEqual([undefined, undefined, undefined]);
    expect(steps[2].preview.lines.join('\n')).toContain('歸入專案「沖繩」');
    const log = await applyPlan(steps, '去沖繩');
    const p = (await db.projects.toArray()).find((x) => x.name === '沖繩')!;
    expect(p.isTravel).toBe(true);
    expect((await db.settings.get('travelModeProjectId'))!.value).toBe(p.id);
    expect(useSettings.getState().travelModeProjectId).toBe(p.id);
    expect((await db.transactions.toArray())[0].projectId).toBe(p.id);

    expect((await undoOp(log.id)).skipped).toBe(0);
    expect((await db.settings.get('travelModeProjectId'))!.value).toBeNull();
    expect(useSettings.getState().travelModeProjectId).toBeNull();
    expect(await db.projects.count()).toBe(0);
  });

  it('切回一般模式：預覽說明、執行後設定清空；非旅遊專案不能切換', async () => {
    await db.projects.add({ id: 'p1', name: '裝修', icon: '📁', color: '', start: today, currency: 'TWD', status: 'active', createdAt: 1, updatedAt: 1 } as never);
    const steps = await previewPlan([
      step('set_travel_mode', { project: '裝修' }),
      step('set_travel_mode', { project: null }),
    ]);
    expect(steps[0].preview.blocked).toContain('不是旅遊專案');
    expect(steps[1].preview.title).toBe('切回一般模式');
    const log = await applyPlan([steps[1]], '切回');
    expect((await db.settings.get('travelModeProjectId'))!.value).toBeNull();
    await undoOp(log.id);
  });
});

describe('願望清單', () => {
  it('加入願望 → 延長冷靜期 → 不買了；整包還原後願望消失', async () => {
    const steps = await previewPlan([
      step('add_wish', { name: '耳機', price: 8000, cool_days: 30 }),
      step('decide_wish', { name: '耳機', decision: 'extend' }),
      step('decide_wish', { name: '耳機', decision: 'abandoned' }),
    ]);
    expect(steps.map((s) => s.preview.blocked)).toEqual([undefined, undefined, undefined]);
    const log = await applyPlan(steps, '耳機');
    const w = (await db.wishes.toArray())[0];
    expect(w.status).toBe('abandoned');
    expect(w.decideAt).toBe(addDays(today, 37));
    expect((await undoOp(log.id)).skipped).toBe(0);
    expect(await db.wishes.count()).toBe(0);
  });

  it('買了：標記已買但不自動記帳；找不到等待中的願望會擋下', async () => {
    const steps = await previewPlan([
      step('add_wish', { name: '鍵盤', price: 3000 }),
      step('decide_wish', { name: '鍵盤', decision: 'bought' }),
      step('decide_wish', { name: '鍵盤', decision: 'bought' }),
    ]);
    expect(steps[1].preview.lines.join('\n')).toContain('不會自動記帳');
    expect(steps[2].preview.blocked).toContain('找不到等待中的');
    const log = await applyPlan([steps[0], steps[1]], '鍵盤');
    expect((await db.wishes.toArray())[0].status).toBe('bought');
    expect(await db.transactions.count()).toBe(0);
    await undoOp(log.id);
    expect(await db.wishes.count()).toBe(0);
  });
});

describe('耐久財', () => {
  it('開始追蹤 → 用了一次 → 賣出記二手收入；還原後物品與收入都消失', async () => {
    const steps = await previewPlan([
      step('manage_durable', { action: 'add', name: '相機', cost: 30000, life_years: 5 }),
      step('manage_durable', { action: 'use', name: '相機' }),
      step('manage_durable', { action: 'sell', name: '相機', price: 10000, account: '台新' }),
    ]);
    expect(steps.map((s) => s.preview.blocked)).toEqual([undefined, undefined, undefined]);
    const log = await applyPlan(steps, '相機');
    const d = (await db.durables.toArray())[0];
    expect(d).toMatchObject({ status: 'sold', uses: 1, saleMinor: 1_000_000 });
    const saleTx = (await db.transactions.get(d.saleTxId!))!;
    expect(saleTx).toMatchObject({ type: 'income', amountMinor: 1_000_000, categoryId: 'inc-other_inc' });
    expect(await bal(bank)).toBe(1_000_000 + 1_000_000);

    expect((await undoOp(log.id)).skipped).toBe(0);
    expect(await db.durables.count()).toBe(0);
    expect((await db.transactions.get(d.saleTxId!))!.deletedAt).toBeTruthy();
    expect(await bal(bank)).toBe(1_000_000);
  });

  it('淘汰（賣 0 元）不入帳；重複追蹤同名物品會擋下', async () => {
    const steps = await previewPlan([
      step('manage_durable', { action: 'add', name: '舊手機', cost: 20000 }),
      step('manage_durable', { action: 'add', name: '舊手機', cost: 20000 }),
      step('manage_durable', { action: 'sell', name: '舊手機', price: 0 }),
    ]);
    expect(steps[1].preview.blocked).toContain('已經在追蹤');
    expect(steps[2].preview.txCreated).toBe(0);
    const log = await applyPlan([steps[0], steps[2]], '淘汰');
    expect((await db.durables.toArray())[0].status).toBe('retired');
    expect(await db.transactions.count()).toBe(0);
    await undoOp(log.id);
    expect(await db.durables.count()).toBe(0);
  });
});

describe('觀察清單與股利', () => {
  it('加入觀察＋到價提醒；對已觀察標的再設提醒是附加；還原後清空', async () => {
    const steps = await previewPlan([
      step('add_watch', { symbol: '0050', price: 200, op: '>=' }),
      step('add_watch', { symbol: '0050', price: 150, op: '<=' }),
    ]);
    const log = await applyPlan(steps, '觀察 0050');
    const w = (await db.watchlist.toArray())[0];
    expect(w.stockId).toBe('s50');
    expect(w.alerts).toEqual([
      { op: '>=', priceDec: '200', enabled: true },
      { op: '<=', priceDec: '150', enabled: true },
    ]);
    expect((await undoOp(log.id)).skipped).toBe(0);
    expect(await db.watchlist.count()).toBe(0);
  });

  it('買進後記現金股利：扣匯費後實拿入帳；還原後股利、帳目、交易全復原', async () => {
    const steps = await previewPlan([
      step('buy_stock', { symbol: '0050', shares: 1000, account: '台新' }),
      step('add_dividend', { symbol: '0050', per_share: 2, account: '台新' }),
    ]);
    expect(steps.map((s) => s.preview.blocked)).toEqual([undefined, undefined]);
    expect(steps[1].preview.lines.join('\n')).toContain('實拿');
    const b0 = await bal(bank);
    const log = await applyPlan(steps, '股利');
    const div = (await db.dividends.toArray())[0];
    // 每股 2 × 1000 股 = 2,000；扣匯費 10 → 實拿 1,990
    expect(div).toMatchObject({ grossMinor: 200_000, feeMinor: 1_000, netMinor: 199_000, status: 'paid' });
    const incTx = (await db.transactions.get(div.transactionId!))!;
    expect(incTx).toMatchObject({ type: 'income', amountMinor: 199_000, categoryId: 'inc-dividend' });
    const buyTotal = 180_000 * 100 + (await db.stock_trades.toArray())[0].feeMinor;
    expect(await bal(bank)).toBe(b0 - buyTotal + 199_000);

    expect((await undoOp(log.id)).skipped).toBe(0);
    expect(await db.dividends.count()).toBe(0);
    expect(await bal(bank)).toBe(b0);
    expect((await db.transactions.toArray()).every((t) => t.deletedAt)).toBe(true);
    expect((await db.stock_trades.toArray()).every((t) => t.deletedAt)).toBe(true);
  });

  it('擋下：沒有持股就記股利、投資頁沒有的標的', async () => {
    const steps = await previewPlan([
      step('add_dividend', { symbol: '0050', per_share: 2 }),
      step('add_watch', { symbol: '2330', price: 1000 }),
    ]);
    expect(steps[0].preview.blocked).toContain('沒有「0050」的持股');
    expect(steps[1].preview.blocked).toContain('投資頁裡沒有');
  });
});

describe('刪除轉帳／管理欠款／修改目標', () => {
  it('刪除轉帳：兩邊餘額退回；還原後轉帳回來', async () => {
    await addTransfer({ fromAccountId: bank, toAccountId: wallet, fromAmountMinor: 50_000, toAmountMinor: 50_000, feeMinor: 0, date: today, ts: Date.now(), note: '提款' });
    const b0 = [await bal(bank), await bal(wallet)];
    const steps = await previewPlan([step('delete_transfer', { match: { from_account: '台新', to_account: '錢包', amount: 500 } })]);
    expect(steps[0].preview.blocked).toBeUndefined();
    const log = await applyPlan(steps, '刪轉帳');
    expect((await db.transfers.toArray())[0].deletedAt).toBeTruthy();
    expect([await bal(bank), await bal(wallet)]).toEqual([b0[0] + 50_000, b0[1] - 50_000]);
    expect((await undoOp(log.id)).skipped).toBe(0);
    expect((await db.transfers.toArray())[0].deletedAt).toBeFalsy();
    expect([await bal(bank), await bal(wallet)]).toEqual(b0);
  });

  it('取消結清：結清帳目軟刪除、欠款變回未結清；整包還原後回到執行前', async () => {
    const xm = await findOrCreatePerson('小明');
    await addDebts([{ personId: xm.id, direction: 'i_owe_them', amountMinor: 350_000, currency: 'TWD', date: today, note: '代墊' }]);
    const steps = await previewPlan([
      step('settle_debt', { person: '小明', account: '台新' }),
      step('manage_debt', { person: '小明', action: 'unsettle' }),
    ]);
    expect(steps.map((s) => s.preview.blocked)).toEqual([undefined, undefined]);
    expect(steps[1].preview.lines.join('\n')).toContain('退回這份計畫裡結清時入帳的金額');
    const log = await applyPlan(steps, '結清又取消');
    const d = (await db.debts.toArray())[0];
    expect(d.settled).toBe(0);
    expect(d.settleTransferId).toBeUndefined();
    expect(await bal(bank)).toBe(1_000_000);
    expect((await undoOp(log.id)).skipped).toBe(0);
    const d2 = (await db.debts.toArray())[0];
    expect(d2.settled).toBe(0);
    expect(await bal(bank)).toBe(1_000_000);
  });

  it('刪除欠款：整筆刪除（含結清帳目）；還原後欠款救回、回到執行前', async () => {
    const xm = await findOrCreatePerson('小明');
    await addDebts([{ personId: xm.id, direction: 'i_owe_them', amountMinor: 350_000, currency: 'TWD', date: today, note: '代墊' }]);
    const steps = await previewPlan([
      step('settle_debt', { person: '小明', account: '台新' }),
      step('manage_debt', { person: '小明', action: 'delete' }),
    ]);
    const log = await applyPlan(steps, '刪欠款');
    expect(await db.debts.count()).toBe(0);
    expect(await bal(bank)).toBe(1_000_000);
    expect((await undoOp(log.id)).skipped).toBe(0);
    const d = (await db.debts.toArray())[0];
    expect(d).toMatchObject({ settled: 0, amountMinor: 350_000 });
    expect(await bal(bank)).toBe(1_000_000);
  });

  it('修改目標：金額、截止日、連結帳戶、封存；還原後回原樣', async () => {
    const now = Date.now();
    await db.goals.add({ id: 'g1', start: today, name: '日本旅遊', icon: '🎯', color: '', targetMinor: 10_000_000, currency: 'TWD', deadline: '2027-01-01', linkedAccountIds: [], manualSavedMinor: 0, status: 'active', createdAt: now, updatedAt: now } as never);
    const steps = await previewPlan([step('edit_goal', { goal: '日本旅遊', set: { target_amount: 200000, deadline: '2027-06-30', account: '台新', status: 'archived' } })]);
    expect(steps[0].preview.blocked).toBeUndefined();
    const log = await applyPlan(steps, '改目標');
    const g = (await db.goals.get('g1'))!;
    expect(g).toMatchObject({ targetMinor: 20_000_000, deadline: '2027-06-30', linkedAccountIds: [bank], status: 'archived' });
    expect((await undoOp(log.id)).skipped).toBe(0);
    const g2 = (await db.goals.get('g1'))!;
    expect(g2).toMatchObject({ targetMinor: 10_000_000, deadline: '2027-01-01', linkedAccountIds: [], status: 'active' });

    // 取消截止日（null）也要能還原
    const steps2 = await previewPlan([step('edit_goal', { goal: '日本旅遊', set: { deadline: null } })]);
    const log2 = await applyPlan(steps2, '取消截止日');
    expect((await db.goals.get('g1'))!.deadline).toBeUndefined();
    await undoOp(log2.id);
    expect((await db.goals.get('g1'))!.deadline).toBe('2027-01-01');
  });
});

describe('收件匣操作（執行層）', () => {
  const raw = (id: number, text: string, merchant: string): InboxRaw =>
    ({ id, source: 'notify', text, amount: '', merchant, card: '', occurred: '', created_at: new Date().toISOString() });
  beforeEach(() => {
    const s = useSettings.getState();
    s.set('inbox', { ...s.inbox, defaultAccountId: bank });
    apiState.items = [
      raw(1, '於 全家 消費 120 元', '全家'),
      raw(2, '於 7-ELEVEN 消費 85 元', '7-ELEVEN'),
    ];
  });

  it('把收件匣的帳記一記：入帳、向伺服器認領；還原會刪帳目（項目不回到收件匣）', async () => {
    const steps = await previewPlan([step('manage_inbox', { action: 'book' })]);
    expect(steps[0].preview.blocked).toBeUndefined();
    expect(steps[0].preview.txCreated).toBe(2);
    const log = await applyPlan(steps, '收件匣入帳');
    const txs = await db.transactions.toArray();
    expect(txs.map((t) => t.amountMinor).sort((x, y) => x - y)).toEqual([8_500, 12_000]);
    expect(apiState.acked.sort()).toEqual([1, 2]);
    expect(await bal(bank)).toBe(1_000_000 - 20_500);
    expect((await undoOp(log.id)).skipped).toBe(0);
    expect((await db.transactions.toArray()).every((t) => t.deletedAt)).toBe(true);
    expect(await bal(bank)).toBe(1_000_000);
  });

  it('關鍵字只處理符合的；略過會警告無法還原', async () => {
    const steps = await previewPlan([step('manage_inbox', { action: 'skip', keyword: '全家' })]);
    expect(steps[0].preview.title).toContain('略過收件匣 1 筆');
    expect(steps[0].preview.warnings.join('\n')).toContain('無法還原');
    const log = await applyPlan(steps, '略過');
    expect(apiState.acked).toEqual([1]);
    expect(await db.transactions.count()).toBe(0);
    await undoOp(log.id);
  });

  it('收件匣沒有項目時擋下', async () => {
    apiState.items = [];
    invalidateInboxReadOnly();
    const steps = await previewPlan([step('manage_inbox', { action: 'book' })]);
    expect(steps[0].preview.blocked).toContain('沒有待確認項目');
  });
});

describe('原子性', () => {
  it('建立鏈中途失敗：分類／帳戶／專案與後續帳目都不留下', async () => {
    const xm = await findOrCreatePerson('小明');
    await addDebts([{ personId: xm.id, direction: 'i_owe_them', amountMinor: 350_000, currency: 'TWD', date: today, note: '代墊' }]);
    const steps = await previewPlan([
      step('add_category', { name: '毛孩', kind: 'expense' }),
      step('add_account', { name: '寵物錢包', type: 'cash', initial_balance: 500 }),
      step('add_project', { name: '日本行', is_travel: true }),
      step('add_transaction', { type: 'expense', account: '寵物錢包', category: '毛孩', amount: 120 }),
      step('settle_debt', { person: '小明', account: '台新' }),
    ]);
    // 預覽之後、確認之前，那筆欠款在別處被結清了：settle 這步會丟錯，整批必須回滾
    await db.debts.toCollection().modify({ settled: 1 });
    const [c0, a0, p0, t0] = [await db.categories.count(), await db.accounts.count(), await db.projects.count(), await db.transactions.count()];
    await expect(applyPlan(steps, '失敗')).rejects.toThrow();
    expect([await db.categories.count(), await db.accounts.count(), await db.projects.count(), await db.transactions.count()]).toEqual([c0, a0, p0, t0]);
    expect(await bal(bank)).toBe(1_000_000);
    expect(await listAgentOps()).toHaveLength(0);
  });
});
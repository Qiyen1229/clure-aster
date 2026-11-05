import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { addAccount } from '@/db/repo/accounts';
import { addDebts, findOrCreatePerson } from '@/db/repo/plan';
import { applyPlan, listAgentOps, previewPlan, undoOp } from '@/services/agent';
import { summarizePlan, opsOf } from '@/domain/agent/plan';
import { todayKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';

const today = todayKey();
const cat = (id: string, name: string, kind = 'expense') => ({ id, name, kind, parentId: '', icon: '', color: '', sort: 0, archived: 0, createdAt: 1, updatedAt: 1 });

/** v4.1.0 動作圖譜：一句話跨帳目、轉帳、欠款、股票、目標，同一個交易寫入，整包可還原 */
describe('操作助手：跨模組動作（記帳、轉帳、結清、買股、存入目標、檢視卡）', () => {
  let bank = '', card = '', goalId = '';
  const bal = async (id: string) => (await db.accounts.get(id))!.balanceMinor;
  beforeEach(async () => {
    await db.delete(); await db.open();
    useSettings.setState({ ...DEFAULT_SETTINGS, baseCurrency: 'TWD', monthStartDay: 1 } as never);
    await db.categories.bulkAdd([cat('inc-bonus', '年終', 'income'), cat('exp-other', '其他')] as never);
    bank = (await addAccount({ name: '台新', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 1_000_000, includeInNetWorth: true, isLiability: false })).id;
    card = (await addAccount({ name: '信用卡', icon: '', color: '', type: 'credit', currency: 'TWD', initialBalanceMinor: -3_000_000, includeInNetWorth: true, isLiability: true })).id;
    const now = Date.now();
    await db.stocks.add({ id: 's50', market: 'TWSE', symbol: '0050', name: '元大台灣50', currency: 'TWD', assetType: 'etf', lotSize: 1000, createdAt: now, updatedAt: now } as never);
    await db.price_cache.put({ stockId: 's50', priceDec: '180', prevCloseDec: '179', changeDec: '1', changePctDec: '0.5', marketTime: now, source: 'test', updatedAt: now, isManual: false });
    const xm = await findOrCreatePerson('小明');
    await addDebts([{ personId: xm.id, direction: 'i_owe_them', amountMinor: 350_000, currency: 'TWD', date: today, note: '聚餐代墊' }]);
    goalId = 'g-japan';
    await db.goals.add({ id: goalId, start: today, name: '日本旅遊', icon: '🎯', color: '#0A84FF', targetMinor: 10_000_000, currency: 'TWD', linkedAccountIds: [], manualSavedMinor: 0, status: 'active', createdAt: now, updatedAt: now } as never);
  });

  const plan = [
    { tool: 'add_transaction', args: { type: 'income', account: '台新', category: '年終', amount: 200000, note: '年終獎金' } },
    { tool: 'transfer', args: { from_account: '台新', to_account: '信用卡', amount: 20000 } },
    { tool: 'buy_stock', args: { symbol: '0050', shares: 1000, price: null, account: '台新' } },
    { tool: 'settle_debt', args: { person: '小明', direction: 'i_owe_them', amount: 3500, account: '台新' } },
    { tool: 'goal_deposit', args: { goal: '日本旅遊', amount: 50000 } },
    { tool: 'show_view', args: { view: 'fire', retire_age: 55 } },
  ];

  it('預覽：依序在帳戶餘額的工作副本上模擬，不寫入任何資料', async () => {
    const before = JSON.stringify([await db.accounts.toArray(), await db.transactions.count()]);
    const steps = await previewPlan(plan);
    expect(steps.map((s) => s.preview.blocked)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    // 台新：10,000 +200,000 −20,000 −買股(18 萬＋手續費) −3,500
    const buy = steps[2].preview.lines.join('\n');
    expect(buy).toContain('手續費');
    expect(steps[0].preview.lines.join('\n')).toContain('$10,000 → $210,000');
    expect(steps[1].preview.lines.join('\n')).toContain('繳卡費');
    expect(steps[4].preview.lines.join('\n')).toContain('只記錄進度');
    expect(steps[5].preview.view).toEqual({ kind: 'fire', params: { retire_age: 55 } });
    expect(summarizePlan(steps)).toMatchObject({ debtsSettled: 1, blocked: 0 });
    expect(JSON.stringify([await db.accounts.toArray(), await db.transactions.count()])).toBe(before);
  });

  it('執行：橫跨帳目、轉帳、股票、欠款、目標一次落盤；整包一鍵還原後帳戶與資料完全回原樣', async () => {
    const steps = await previewPlan(plan);
    const b0 = [await bal(bank), await bal(card)];
    const log = await applyPlan(steps, '年終分配');
    const buyTotal = 180_000 * 100 + (await db.stock_trades.toArray())[0].feeMinor;
    expect(await bal(bank)).toBe(b0[0] + 200000 * 100 - 20000 * 100 - buyTotal - 3500 * 100);
    expect(await bal(card)).toBe(b0[1] + 20000 * 100); // 繳卡費：欠款減少
    expect((await db.debts.toArray())[0].settled).toBe(1);
    expect((await db.goals.get(goalId))!.manualSavedMinor).toBe(5_000_000);
    expect(await db.stock_trades.count()).toBe(1);
    expect(log.titles.length).toBeGreaterThanOrEqual(5);
    expect((await listAgentOps())).toHaveLength(1);

    const r = await undoOp(log.id);
    expect(r.skipped).toBe(0);
    expect([await bal(bank), await bal(card)]).toEqual(b0);
    expect((await db.debts.toArray())[0].settled).toBe(0);
    expect((await db.goals.get(goalId))!.manualSavedMinor).toBe(0);
    expect((await db.stock_trades.toArray()).every((t) => t.deletedAt)).toBe(true);
    expect((await db.transactions.toArray()).every((t) => t.deletedAt)).toBe(true);
  });

  it('原子性：其中一步執行時失敗，前面的步驟都不會留下（帳戶、欠款、目標原樣）', async () => {
    const steps = await previewPlan(plan);
    // 預覽之後、確認之前，那筆欠款在別處被結清了：settle 這步會丟錯，整批必須回滾
    await db.debts.toCollection().modify({ settled: 1 });
    const b0 = [await bal(bank), await bal(card)];
    const txs = await db.transactions.count();
    await expect(applyPlan(steps, '年終分配')).rejects.toThrow();
    expect([await bal(bank), await bal(card)]).toEqual(b0);
    expect(await db.transactions.count()).toBe(txs);
    expect(await db.stock_trades.count()).toBe(0);
    expect((await db.goals.get(goalId))!.manualSavedMinor).toBe(0);
    expect(await listAgentOps()).toHaveLength(0);
  });

  it('擋下不安全或不支援的動作：外幣帳戶、投資頁沒有的標的、不存在的對象、未來日期', async () => {
    await addAccount({ name: '美元戶', icon: '', color: '', type: 'bank', currency: 'USD', initialBalanceMinor: 100_00, includeInNetWorth: true, isLiability: false });
    const steps = await previewPlan([
      { tool: 'add_transaction', args: { type: 'expense', account: '美元戶', category: null, amount: 10 } },
      { tool: 'buy_stock', args: { symbol: '2330', shares: 1000, price: 900 } },
      { tool: 'settle_debt', args: { person: '路人', amount: null } },
      { tool: 'add_transaction', args: { type: 'income', account: '台新', category: '年終', amount: 100, date: '2999-01-01' } },
      { tool: 'transfer', args: { from_account: '台新', to_account: '台新', amount: 1 } },
      { tool: 'show_view', args: { view: 'hack' } },
    ]);
    expect(steps.map((s) => !!s.preview.blocked)).toEqual([true, true, true, true, true, true]);
    expect(steps[1].preview.blocked).toContain('投資頁');
    expect(steps.flatMap(opsOf)).toHaveLength(0);
    await expect(applyPlan(steps, 'x')).rejects.toThrow('沒有可以執行的步驟');
  });

  it('買股：證券戶沒指定時用第一個證券帳戶，扣款走它的交割帳戶；上櫃與興櫃也算台股', async () => {
    const brk = await addAccount({ name: '元大證券', icon: '', color: '', type: 'brokerage', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false, brokerage: { feeDiscountDec: '0.6', minFeeMinor: 2000, oddLotMinFeeMinor: 100, settlementAccountId: bank } } as never);
    await db.stocks.update('s50', { market: 'TPEX' } as never);
    const steps = await previewPlan([{ tool: 'buy_stock', args: { symbol: '0050', shares: 1000, price: 180 } }]);
    expect(steps[0].preview.blocked).toBeUndefined();
    expect(steps[0].preview.lines.join('\n')).toContain('「台新」');
    const op = steps[0].op as { kind: 'trade'; input: { accountId: string; cashAccountId: string } };
    expect(op.input.accountId).toBe(brk.id);
    expect(op.input.cashAccountId).toBe(bank);
  });

  it('同一份計畫新建的目標可以直接存入（併入建立那一步），一次建立', async () => {
    const steps = await previewPlan([
      { tool: 'add_goal', args: { name: '新目標', target_amount: 100000, deadline: null } },
      { tool: 'goal_deposit', args: { goal: '新目標', amount: 30000 } },
    ]);
    await applyPlan(steps, '新目標');
    const g = (await db.goals.toArray()).find((x) => x.name === '新目標')!;
    expect(g.manualSavedMinor).toBe(3_000_000);
  });
});

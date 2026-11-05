import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction } from '@/db/repo/ledger';
import { applyPlan, listAgentOps, loadAgentData, previewPlan, undoOp } from '@/services/agent';
import { summarizePlan } from '@/domain/agent/plan';
import { amortize, paymentFor, simulatePrepayment } from '@/domain/loan';
import { todayKey, addDays } from '@/domain/period';
import { useSettings } from '@/stores/settings';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';

const today = todayKey();
const lastMonth = addDays(`${today.slice(0, 8)}01`, -10); // 上個月中旬
const cat = (id: string, name: string, kind = 'expense', parentId = '') => ({ id, name, kind, parentId, icon: '', color: '', sort: 0, archived: 0, createdAt: 1, updatedAt: 1 });

describe('操作助手：預覽、執行、還原', () => {
  let accId = '';
  beforeEach(async () => {
    await db.delete(); await db.open();
    useSettings.setState({ ...DEFAULT_SETTINGS, baseCurrency: 'TWD', monthStartDay: 1 } as never);
    await db.categories.bulkAdd([cat('exp-food', '飲食'), cat('exp-transport', '交通'), cat('exp-commute', '通勤'), cat('exp-sub', '訂閱'), cat('inc-salary', '薪水', 'income')] as never);
    accId = (await addAccount({ name: '玉山', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false })).id;
  });
  const spend = (note: string, yuan: number, date: string, categoryId = 'exp-transport') =>
    addTransaction({ type: 'expense', accountId: accId, categoryId, amountMinor: yuan * 100, currency: 'TWD', date, ts: 1, note });
  const bal = async () => (await db.accounts.get(accId))!.balanceMinor;

  const plan = [
    { tool: 'reclassify', args: { keywords: ['uber', '台灣大車隊'], from_category: null, account: null, type: 'expense', date_start: null, date_end: null, to_category: '通勤' } },
    { tool: 'set_budget', args: { category: '通勤', amount: 3000, alert_percent: 80 } },
  ];

  it('預覽：模擬改分類後的預算影響；後面的步驟看得到前面步驟的結果；不寫入任何資料', async () => {
    await spend('Uber 上班', 200, today); await spend('台灣大車隊', 300, today); await spend('捷運', 50, today); await spend('Uber 去年', 999, lastMonth);
    const before = JSON.stringify(await db.transactions.toArray());
    const steps = await previewPlan(plan);
    expect(steps[0].preview.blocked).toBeUndefined();
    expect(steps[0].preview.affectedTx).toBe(3); // 捷運不符；兩筆今天＋一筆上個月的 Uber
    expect(steps[0].preview.lines.join('\n')).toContain('帳戶餘額：不受影響');
    // 本月通勤已花＝今天兩筆 500（上個月那筆不算本月）→ 新預算 3000 的 17%
    expect(steps[1].preview.lines.join('\n')).toContain('用掉 17%');
    expect(summarizePlan(steps)).toMatchObject({ affectedTx: 3, budgetChanges: 1, executable: 2, blocked: 0 });
    expect(JSON.stringify(await db.transactions.toArray())).toBe(before); // 預覽不改資料
  });

  it('執行：改分類＋建預算在同一交易；帳戶餘額不變；一鍵還原後完全回到原樣', async () => {
    await spend('Uber', 200, today); await spend('台灣大車隊', 300, today);
    const b0 = await bal();
    const snapshot = JSON.stringify((await db.transactions.toArray()).map((t) => [t.id, t.categoryId]));
    const log = await applyPlan(await previewPlan(plan), '歸通勤並設預算');
    expect((await db.transactions.toArray()).every((t) => t.categoryId === 'exp-commute')).toBe(true);
    const budgets = await db.budgets.toArray();
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({ categoryId: 'exp-commute', amountMinor: 300000, alertPercents: [80], periodType: 'month' });
    expect(await bal()).toBe(b0);
    expect((await listAgentOps())[0].id).toBe(log.id);

    const r = await undoOp(log.id);
    expect(r).toEqual({ restored: 3, skipped: 0 });
    expect(JSON.stringify((await db.transactions.toArray()).map((t) => [t.id, t.categoryId]))).toBe(snapshot);
    expect(await db.budgets.count()).toBe(0);
    await expect(undoOp(log.id)).rejects.toThrow('已經還原過');
  });

  it('還原：執行後又被使用者改過的帳目不會被蓋掉（回報略過）', async () => {
    const t1 = await spend('Uber', 200, today); await spend('Uber 2', 100, today);
    const log = await applyPlan(await previewPlan([plan[0]]), 'x');
    await db.transactions.update(t1.id, { categoryId: 'exp-food', updatedAt: Date.now() + 5 }); // 使用者之後手動改了
    const r = await undoOp(log.id);
    expect(r).toEqual({ restored: 1, skipped: 1 });
    expect((await db.transactions.get(t1.id))?.categoryId).toBe('exp-food');
  });

  it('更新既有預算：還原會寫回原本的金額', async () => {
    await db.budgets.add({ id: 'b1', name: '通勤預算', periodType: 'month', startDate: `${today.slice(0, 8)}01`, amountMinor: 100000, currency: 'TWD', categoryId: 'exp-commute', projectId: '', rollover: false, alertPercents: [90], active: 1, createdAt: 1, updatedAt: 1 } as never);
    const log = await applyPlan(await previewPlan([plan[1]]), 'x');
    expect(await db.budgets.get('b1')).toMatchObject({ amountMinor: 300000, alertPercents: [80] });
    await undoOp(log.id);
    expect(await db.budgets.get('b1')).toMatchObject({ amountMinor: 100000, alertPercents: [90] });
  });

  it('原子性：中途失敗整批不寫入', async () => {
    await spend('Uber', 200, today);
    const steps = await previewPlan(plan);
    const bad = steps.map((s) => (s.op?.kind === 'budget' ? { ...s, op: { ...s.op, id: 'not-exist' } } : s));
    await expect(applyPlan(bad, 'x')).rejects.toThrow();
    expect((await db.transactions.toArray())[0].categoryId).toBe('exp-transport'); // 改分類也被一起退回
    expect(await listAgentOps()).toHaveLength(0);
  });

  it('安全：沒有篩選條件、找不到分類、超過上限、不支援的工具都會被擋下，而且不會執行', async () => {
    await spend('Uber', 200, today);
    const steps = await previewPlan([
      { tool: 'reclassify', args: { keywords: [], to_category: '通勤' } },
      { tool: 'reclassify', args: { keywords: ['uber'], to_category: '不存在' } },
      { tool: 'drop_database', args: {} },
      { tool: 'reclassify', args: { keywords: ['完全沒有的店'], to_category: '通勤' } },
    ]);
    expect(steps.every((s) => !!s.preview.blocked && !s.op)).toBe(true);
    await expect(applyPlan(steps, 'x')).rejects.toThrow('沒有可以執行');
    const many = Array.from({ length: 501 }, (_, i) => ({ ...({} as object), id: `m${i}`, type: 'expense', accountId: accId, categoryId: 'exp-food', amountMinor: 100, baseAmountMinor: 100, accountAmountMinor: 100, currency: 'TWD', date: today, ts: 1, note: '全家', tagIds: [], attachmentIds: [], createdAt: 1, updatedAt: 1 }));
    await db.transactions.bulkAdd(many as never);
    const big = await previewPlan([{ tool: 'reclassify', args: { keywords: ['全家'], to_category: '交通' } }]);
    expect(big[0].preview.blocked).toContain('上限');
  });

  it('週期帳目：每月 12 號 Netflix 390；有同名規則時警告；執行與還原', async () => {
    const step = { tool: 'add_recurring', args: { name: 'Netflix', amount: 390, freq: 'month', day: 12, category: '訂閱', account: '玉山', kind: 'subscription', start_date: null } };
    const steps = await previewPlan([step]);
    expect(steps[0].preview.title).toContain('每月 12 號');
    expect(steps[0].preview.lines.join('')).toContain('-12');
    const log = await applyPlan(steps, 'x');
    const rule = (await db.recurring_rules.toArray())[0];
    expect(rule).toMatchObject({ name: 'Netflix', kind: 'subscription', mode: 'confirm', template: { amountMinor: 39000, categoryId: 'exp-sub', accountId: accId } });
    expect((await previewPlan([step]))[0].preview.warnings.join('')).toContain('同名');
    await undoOp(log.id);
    expect(await db.recurring_rules.count()).toBe(0);
  });

  it('週期帳目沒說分類：訂閱類帶「訂閱」、其他帶「其他」，並在預覽提醒；有給但找不到的分類仍會擋下', async () => {
    const step = { tool: 'add_recurring', args: { name: 'Netflix', amount: 390, freq: 'month', day: 12, category: null, account: '玉山', kind: 'subscription' } };
    const [a] = await previewPlan([step]);
    expect(a.preview.blocked).toBeUndefined();
    expect(a.op && a.op.kind === 'recurring' && a.op.input.template.categoryId).toBe('exp-sub');
    expect(a.preview.warnings.join('')).toContain('沒有指定分類');
    const [b] = await previewPlan([{ ...step, args: { ...step.args, category: '亂寫' } }]);
    expect(b.preview.blocked).toContain('找不到');
  });

  it('批次改分類：同名的收入／支出分類依 type 挑對的那個', async () => {
    await db.categories.add(cat('inc-commute', '通勤', 'income') as never);
    await spend('Uber', 200, today);
    const [r] = await previewPlan([{ tool: 'reclassify', args: { keywords: ['uber'], type: 'expense', to_category: '通勤' } }]);
    expect(r.op && r.op.kind === 'recat' && r.op.categoryId).toBe('exp-commute');
  });

  it('新工具：自動分類規則＋存錢目標——預覽、執行、一鍵還原；與改分類串聯（過去改分類＋以後自動歸類）', async () => {
    await spend('Uber 上班', 200, today); await spend('Uber 回家', 300, today);
    const steps = await previewPlan([
      { tool: 'reclassify', args: { keywords: ['uber'], to_category: '通勤' } },
      { tool: 'add_rule', args: { pattern: 'Uber', category: '通勤', account: '玉山' } },
      { tool: 'add_goal', args: { name: '日本旅行', target_amount: 50000, deadline: addDays(today, 150) } },
    ]);
    expect(steps.every((s) => !s.preview.blocked)).toBe(true);
    // 規則預覽看得到「前面步驟改分類後」已有 2 筆在通勤
    expect(steps[1].preview.lines.join('')).toContain('其中 2 筆已在');
    expect(steps[2].preview.lines.join('')).toMatch(/平均每月要存 \$\d/);
    expect(summarizePlan(steps)).toMatchObject({ affectedTx: 2, autoRulesCreated: 1, goalsCreated: 1, executable: 3 });
    const log = await applyPlan(steps, 'x');
    expect(await db.rules.toArray()).toMatchObject([{ keyword: 'Uber', match: 'contains', kind: 'expense', categoryId: 'exp-commute', accountId: accId, enabled: true }]);
    expect(await db.goals.toArray()).toMatchObject([{ name: '日本旅行', targetMinor: 5_000_000, status: 'active' }]);
    const r = await undoOp(log.id);
    expect(r.skipped).toBe(0);
    expect(await db.rules.count()).toBe(0);
    expect(await db.goals.count()).toBe(0);
  });

  it('新工具的安全檢查：關鍵字太短、找不到分類、金額不正確都會被擋下', async () => {
    const steps = await previewPlan([
      { tool: 'add_rule', args: { pattern: 'x', category: '通勤' } },
      { tool: 'add_rule', args: { pattern: 'uber', category: '亂寫' } },
      { tool: 'add_goal', args: { name: '', target_amount: 1000 } },
      { tool: 'add_goal', args: { name: '旅行', target_amount: 0 } },
    ]);
    expect(steps.every((s) => !!s.preview.blocked && !s.op)).toBe(true);
  });

  it('資料載入：候選帳目只含近一年未刪除的', async () => {
    await spend('今天', 1, today); await spend('兩年前', 1, addDays(today, -800));
    expect((await loadAgentData()).txs.map((t) => t.note)).toEqual(['今天']);
  });
});

describe('提前還款試算', () => {
  it('一次還款：縮短年限省利息 > 降低月付省利息；金額一致性', () => {
    const bal = 5_000_000_00, apr = '2.2', n = 240;
    const pay = paymentFor(bal, apr, n);
    const base = amortize(bal, apr, pay)!;
    expect(base.months).toBeGreaterThanOrEqual(n - 1); expect(base.months).toBeLessThanOrEqual(n + 1);
    const sim = simulatePrepayment({ balanceMinor: bal, aprDec: apr, paymentMinor: pay, lumpMinor: 1_000_000_00, extraMonthlyMinor: 5_000_00 })!;
    expect(sim.shorten!.savedMonths).toBeGreaterThan(30);
    expect(sim.shorten!.savedInterestMinor).toBeGreaterThan(sim.lowerPayment!.savedInterestMinor); // 縮短年限省更多
    expect(sim.lowerPayment!.paymentDropMinor).toBeGreaterThan(0);
    expect(sim.extra!.savedMonths).toBeGreaterThan(0);
  });
  it('月付不夠付利息 → 無法試算（null）；0 利率正確', () => {
    expect(simulatePrepayment({ balanceMinor: 1_000_000_00, aprDec: '10', paymentMinor: 100_00 })).toBeNull();
    expect(amortize(120_000, '0', 10_000)).toMatchObject({ months: 12, interestMinor: 0 });
    expect(paymentFor(120_000, '0', 12)).toBe(10_000);
  });
});

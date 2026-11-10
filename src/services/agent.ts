/**
 * 操作助手的執行層：載入模擬所需資料、把計畫真的寫入（單一 Dexie 交易＝要嘛全成功要嘛全不動）、
 * 並為每次執行留下「修改前的樣子」，讓使用者一鍵還原。
 *
 * v4.1.0：一份計畫可以橫跨帳目、轉帳、欠款、股票交易、目標、預算…多張資料表，仍是同一個 Dexie 交易（全成功或全不動）；
 * 整包計畫共用一筆還原紀錄，還原時依相反順序逐一復原（記帳／轉帳／交易走各自的刪除流程，帳戶餘額跟著回復）。
 *
 * 還原紀錄存在本機 meta 表（不同步），保留 7 天、最多 20 筆。還原時逐筆檢查：那一筆在執行後又被改過
 * （updatedAt 不同）就不動它並告知，避免蓋掉使用者之後的修改。寫回時間戳更新，所以其他裝置同步時也會跟著還原。
 */
import { db, uid } from '@/db/schema';
import { deleteBudget, saveBudget, saveGoal, saveRecurring, settleDebt, unsettleDebt } from '@/db/repo/plan';
import { addTransaction, addTransfer, deleteTransactions, deleteTransfers, restoreTransactions, updateTransaction, type TxInput } from '@/db/repo/ledger';
import { addTrade, deleteTrade } from '@/db/repo/invest';
import { twFeeConfig } from './portfolio';
import { computePosition } from '@/domain/invest/position';
import { currencyInfo } from '@/domain/money';
import { invalidateAutocat } from './autocat';
import type { Transaction } from '@/db/types';
import { opsOf, resolvePlan, type AgentData, type RawStep, type ResolvedStep } from '@/domain/agent/plan';
import { addDays, todayKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';

const OPS_KEY = 'agent.ops';
const KEEP_DAYS = 7;
const KEEP_N = 20;

type Table = 'transactions' | 'budgets' | 'recurring_rules' | 'goals' | 'rules' | 'transfers' | 'debts' | 'stock_trades';
interface Change {
  table: Table;
  id: string;
  /** undefined＝這次新增的（還原時刪除）；否則是修改前要寫回的欄位／整列 */
  before?: Record<string, unknown>;
  /** 執行後的 updatedAt：還原前用來確認沒被改過 */
  stamp: number;
  /** 需要走專用流程還原的類型（帳戶餘額、關聯帳目要一起回復）；沒有值就是單純的刪除／寫回修改前的樣子 */
  undo?: 'tx' | 'transfer' | 'settle' | 'trade' | 'txedit' | 'txdel';
}
export interface AgentOpLog {
  id: string;
  at: number;
  summary: string;
  titles: string[];
  changes: Change[];
  undoneAt?: number;
}

/** 載入預覽模擬需要的資料（候選帳目＝近一年未刪除的） */
export async function loadAgentData(): Promise<AgentData> {
  const today = todayKey();
  const st = useSettings.getState();
  const [categories, accounts, budgets, recurring, goals, rules, debtRows, people, stockRows, prices, tradeRows, txs] = await Promise.all([
    db.categories.toArray(), db.accounts.toArray(), db.budgets.toArray(), db.recurring_rules.toArray(), db.goals.toArray(), db.rules.toArray(),
    db.debts.toArray(), db.people.toArray(), db.stocks.toArray(), db.price_cache.toArray(), db.stock_trades.toArray(),
    db.transactions.where('date').aboveOrEqual(addDays(today, -365)).toArray().then((rows) => rows.filter((t) => !t.deletedAt)), // 先整批讀再過濾：Dexie 的 .filter() 會逐筆走游標，上萬筆時慢很多
  ]);
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const priceOf = new Map(prices.map((p) => [p.stockId, p.priceDec]));
  // 目前持股股數（賣出要檢查夠不夠賣）：照投資頁同一套持倉算法
  const holdings: Record<string, string> = {};
  for (const s of stockRows) {
    if (s.deletedAt) continue;
    const mine = tradeRows.filter((t) => t.stockId === s.id && !t.deletedAt);
    if (mine.length) holdings[s.id] = computePosition(mine, st.invest.costMethod, currencyInfo(s.currency).exp).shares.toString();
  }
  return {
    today, baseCurrency: st.baseCurrency, monthStartDay: st.monthStartDay, categories, accounts, budgets, recurring, goals, rules, txs, defaultAccountId: st.lastAccountId || undefined,
    debts: debtRows.filter((x) => !x.deletedAt).map((x) => ({ id: x.id, personName: personName.get(x.personId) ?? '', direction: x.direction, amountMinor: x.amountMinor, currency: x.currency, note: x.note, settled: x.settled })),
    stocks: stockRows.filter((x) => !x.deletedAt).map((x) => ({ id: x.id, symbol: x.symbol, name: x.name, market: x.market, currency: x.currency, assetType: x.assetType, lotSize: x.lotSize, priceDec: priceOf.get(x.id), taxRateDec: x.taxRateDec })), holdings,
    feeConfig: twFeeConfig(st.invest), defaultBrokerageId: st.invest.defaultBrokerageId || undefined,
  };
}

export async function previewPlan(steps: RawStep[]): Promise<ResolvedStep[]> {
  return resolvePlan(steps, await loadAgentData());
}

async function readLog(): Promise<AgentOpLog[]> {
  const rows = ((await db.meta.get(OPS_KEY).catch(() => undefined))?.value as AgentOpLog[] | undefined) ?? [];
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  return rows.filter((r) => r.at >= cutoff).slice(-KEEP_N);
}

export async function listAgentOps(): Promise<AgentOpLog[]> {
  return (await readLog()).sort((a, b) => b.at - a.at);
}

/**
 * 執行計畫（只執行可執行、沒被擋下的步驟）。全部在同一個交易裡：任何一步失敗，整批都不會寫入。
 * 回傳紀錄（含還原所需的資訊）。
 */
const appliedPlans = new Map<string, AgentOpLog>();

export async function applyPlan(steps: ResolvedStep[], summary: string, idempotencyKey?: string): Promise<AgentOpLog> {
  if (idempotencyKey && appliedPlans.has(idempotencyKey)) {
    return appliedPlans.get(idempotencyKey)!;
  }
  const ops = steps.flatMap((s) => opsOf(s).map((op) => ({ op, title: s.preview.title })));
  if (!ops.length) throw new Error('沒有可以執行的步驟');
  const titles = [...new Set(ops.map((o) => o.title))];
  const log: AgentOpLog = { id: idempotencyKey || uid(), at: Date.now(), summary: summary || titles[0], titles, changes: [] };
  await db.transaction('rw', [db.transactions, db.transfers, db.accounts, db.attachments, db.durables, db.budgets, db.budget_periods, db.recurring_rules, db.goals, db.rules,
    db.debts, db.people, db.stocks, db.stock_trades, db.settings, db.meta], async () => {
    for (const { op } of ops) {
      if (op.kind === 'recat') {
        for (const id of op.ids) {
          const t = await db.transactions.get(id);
          if (!t || t.deletedAt) continue;
          log.changes.push({ table: 'transactions', id, before: { categoryId: t.categoryId }, stamp: 0 });
          await db.transactions.update(id, { categoryId: op.categoryId, updatedAt: Date.now() });
        }
      } else if (op.kind === 'tx_edit') {
        const t = await db.transactions.get(op.id);
        if (!t || t.deletedAt) continue;
        log.changes.push({ table: 'transactions', id: t.id, before: { ...t }, stamp: 0, undo: 'txedit' });
        const next = inputOf(t);
        if (op.set.amountMinor !== undefined) next.amountMinor = op.set.amountMinor;
        if (op.set.categoryId) next.categoryId = op.set.categoryId;
        if (op.set.accountId) next.accountId = op.set.accountId;
        if (op.set.note !== undefined) next.note = op.set.note;
        if (op.set.date) { next.date = op.set.date; next.ts = new Date(`${op.set.date}T${new Date(t.ts).toTimeString().slice(0, 8)}`).getTime(); }
        await updateTransaction(t.id, next);
      } else if (op.kind === 'tx_delete') {
        for (const id of op.ids) {
          const t = await db.transactions.get(id);
          if (!t || t.deletedAt) continue;
          log.changes.push({ table: 'transactions', id, stamp: 0, undo: 'txdel' });
          await deleteTransactions([id]);
        }
      } else if (op.kind === 'budget') {
        if (op.id) {
          const before = await db.budgets.get(op.id);
          if (!before) throw new Error('要調整的預算已不存在');
          log.changes.push({ table: 'budgets', id: op.id, before: { ...before }, stamp: 0 });
          await saveBudget(op.input, op.id);
        } else {
          const id = await saveBudget(op.input);
          log.changes.push({ table: 'budgets', id, stamp: 0 });
        }
      } else if (op.kind === 'goal') {
        const id = await saveGoal(op.input);
        log.changes.push({ table: 'goals', id, stamp: 0 });
      } else if (op.kind === 'goal_deposit') {
        const g = await db.goals.get(op.goalId);
        if (!g) throw new Error('要存入的目標已不存在');
        log.changes.push({ table: 'goals', id: g.id, before: { ...g }, stamp: 0 });
        await saveGoal({ ...stripRow(g), manualSavedMinor: g.manualSavedMinor + op.amountMinor }, g.id);
      } else if (op.kind === 'rule') {
        const id = uid();
        const now = Date.now();
        await db.rules.add({ ...op.input, id, hits: 0, createdAt: now, updatedAt: now });
        log.changes.push({ table: 'rules', id, stamp: 0 });
      } else if (op.kind === 'tx') {
        const t = await addTransaction({ ...op.input, ts: Date.now() });
        log.changes.push({ table: 'transactions', id: t.id, stamp: 0, undo: 'tx' });
      } else if (op.kind === 'transfer') {
        const tr = await addTransfer({ fromAccountId: op.input.fromAccountId, toAccountId: op.input.toAccountId, fromAmountMinor: op.input.amountMinor, toAmountMinor: op.input.amountMinor, feeMinor: 0, date: op.input.date, ts: Date.now(), note: op.input.note });
        log.changes.push({ table: 'transfers', id: tr.id, stamp: 0, undo: 'transfer' });
      } else if (op.kind === 'settle') {
        const before = await db.debts.get(op.debtId);
        if (!before || before.settled) throw new Error('這筆欠款已經結清或不存在');
        log.changes.push({ table: 'debts', id: before.id, before: { ...before }, stamp: 0, undo: 'settle' });
        await settleDebt(before.id, op.accountId);
      } else if (op.kind === 'trade') {
        const stock = await db.stocks.get(op.input.stockId);
        if (!stock) throw new Error('標的不存在');
        const inv = useSettings.getState().invest;
        const t = await addTrade({
          stockId: op.input.stockId, accountId: op.input.accountId, type: op.input.side, date: op.input.date, ts: Date.now(), sharesDec: op.input.sharesDec, priceDec: op.input.priceDec,
          feeMinor: op.input.feeMinor, taxMinor: op.input.taxMinor, fxRateDec: '1', isDCA: false, syncToLedger: true, cashAccountId: op.input.cashAccountId, note: '由 AI 操作助手記錄', costMethodSnapshot: inv.costMethod,
        });
        log.changes.push({ table: 'stock_trades', id: t.id, stamp: 0, undo: 'trade' });
      } else {
        const id = await saveRecurring(op.input);
        log.changes.push({ table: 'recurring_rules', id, stamp: 0 });
      }
    }
    for (const c of log.changes) c.stamp = ((await db.table(c.table).get(c.id)) as { updatedAt: number } | undefined)?.updatedAt ?? 0;
    await db.meta.put({ key: OPS_KEY, value: [...(await readLog()), log] });
  });
  if (log.changes.some((c) => c.table === 'rules')) invalidateAutocat();
  appliedPlans.set(log.id, log);
  return log;
}

/** 把已存在的帳目轉回輸入格式（改單筆、還原用）；updateTransaction 只覆蓋有給值的欄位，其餘關聯（週期、分期…）保留 */
function inputOf(t: Transaction): TxInput {
  return {
    type: t.type, accountId: t.accountId, categoryId: t.categoryId, amountMinor: t.amountMinor, currency: t.currency, fxRateDec: t.fxRateDec, date: t.date, ts: t.ts,
    note: t.note, merchant: t.merchant, invoiceNo: t.invoiceNo, tagIds: t.tagIds, projectId: t.projectId, attachmentIds: t.attachmentIds,
    excludeFromBudget: t.excludeFromBudget, excludeFromStats: t.excludeFromStats, split: t.split,
  };
}

/** 去掉資料列的 id／時間戳，剩下可以重新寫入的欄位 */
function stripRow<T extends { id: string; createdAt: number; updatedAt: number }>(r: T): Omit<T, 'id' | 'createdAt' | 'updatedAt'> {
  const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = r;
  return rest;
}

export interface UndoResult { restored: number; skipped: number }

/** 一鍵還原：把這次執行改的、建的全部復原；執行後又被改過的那幾筆不動並回報 */
export async function undoOp(id: string): Promise<UndoResult> {
  const res: UndoResult = { restored: 0, skipped: 0 };
  await db.transaction('rw', [db.transactions, db.transfers, db.accounts, db.attachments, db.durables, db.budgets, db.budget_periods, db.recurring_rules, db.goals, db.rules,
    db.debts, db.people, db.stocks, db.stock_trades, db.settings, db.meta], async () => {
    const all = await readLog();
    const log = all.find((l) => l.id === id);
    if (!log) throw new Error('找不到這筆操作紀錄（可能已超過 7 天）');
    if (log.undoneAt) throw new Error('這筆操作已經還原過了');
    for (const c of [...log.changes].reverse()) {
      const cur = (await db.table(c.table).get(c.id)) as { updatedAt: number } | undefined;
      if (!cur || cur.updatedAt !== c.stamp) { res.skipped++; continue; }
      if (c.undo === 'tx') await deleteTransactions([c.id]);
      else if (c.undo === 'transfer') await deleteTransfers([c.id]);
      else if (c.undo === 'settle') await unsettleDebt(c.id);
      else if (c.undo === 'trade') await deleteTrade(c.id);
      else if (c.undo === 'txedit' && c.before) await updateTransaction(c.id, inputOf(c.before as unknown as Transaction));
      else if (c.undo === 'txdel') await restoreTransactions([c.id]);
      else if (c.before === undefined) {
        if (c.table === 'budgets') await deleteBudget(c.id);
        else await db.table(c.table).delete(c.id);
      } else if (c.table === 'transactions') {
        await db.transactions.update(c.id, { ...c.before, updatedAt: Date.now() });
      } else {
        await db.table(c.table).put({ ...c.before, updatedAt: Date.now() });
      }
      res.restored++;
    }
    log.undoneAt = Date.now();
    await db.meta.put({ key: OPS_KEY, value: all });
  });
  invalidateAutocat();
  return res;
}

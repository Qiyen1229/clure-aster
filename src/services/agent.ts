/**
 * 操作助手的執行層：載入模擬所需資料、把計畫真的寫入（單一 Dexie 交易＝要嘛全成功要嘛全不動）、
 * 並為每次執行留下「修改前的樣子」，讓使用者一鍵還原。
 *
 * v4.1.0：一份計畫可以橫跨帳目、轉帳、欠款、股票交易、目標、預算…多張資料表，仍是同一個 Dexie 交易（全成功或全不動）；
 * 整包計畫共用一筆還原紀錄，還原時依相反順序逐一復原（記帳／轉帳／交易走各自的刪除流程，帳戶餘額跟著回復）。
 * v4.1.39：計畫裡新建的分類／帳戶／專案先執行、取得真實 id，再把後面步驟裡的草稿 id 換掉；
 * 收件匣操作（伺服器認領）無法放進 Dexie 交易，在本機寫入完成後才處理。
 *
 * 還原紀錄存在本機 meta 表（不同步），保留 7 天、最多 20 筆。還原時逐筆檢查：那一筆在執行後又被改過
 * （updatedAt 不同）就不動它並告知，避免蓋掉使用者之後的修改。寫回時間戳更新，所以其他裝置同步時也會跟著還原。
 */
import { db, uid } from '@/db/schema';
import { addDebts, addInstallment, addLoan, addWish, confirmPending, decideWish, deleteBudget, extendWish, findOrCreatePerson, removeLoan, saveBudget, saveGoal, saveProject, saveRecurring, settleDebt, skipPending, unsettleDebt } from '@/db/repo/plan';
import { addTransaction, addTransfer, deleteTransactions, deleteTransfers, restoreTransactions, restoreTransfers, updateTransaction, type TxInput } from '@/db/repo/ledger';
import { addTrade, addWatch, deleteDividend, deleteTrade, saveDividend, updateAlerts } from '@/db/repo/invest';
import { addDurable, addUse, sellDurable } from '@/db/repo/durables';
import { accountTypeInfo, addAccount } from '@/db/repo/accounts';
import { addCategory, deleteOrArchiveCategory } from '@/db/repo/categories';
import { saveSetting } from '@/db/repo/settings';
import { twFeeConfig } from './portfolio';
import { computePosition } from '@/domain/invest/position';
import { currencyInfo } from '@/domain/money';
import { invalidateAutocat } from './autocat';
import type { Transaction } from '@/db/types';
import { opsOf, resolvePlan, type AgentData, type Op, type RawStep, type ResolvedStep } from '@/domain/agent/plan';
import { addDays, todayKey } from '@/domain/period';
import { applyTheme, useSettings } from '@/stores/settings';
import { ackInbox, bookInboxEntries, invalidateInboxReadOnly, loadInboxReadOnly } from './inbox';

const OPS_KEY = 'agent.ops';
const KEEP_DAYS = 7;
const KEEP_N = 20;

type Table = 'transactions' | 'budgets' | 'recurring_rules' | 'goals' | 'rules' | 'transfers' | 'debts' | 'stock_trades'
  | 'categories' | 'accounts' | 'projects' | 'wishes' | 'durables' | 'installments' | 'dividends' | 'watchlist' | 'settings';
interface Change {
  table: Table;
  id: string;
  /** undefined＝這次新增的（還原時刪除）；否則是修改前要寫回的欄位／整列 */
  before?: Record<string, unknown>;
  /** 執行後的 updatedAt：還原前用來確認沒被改過 */
  stamp: number;
  /** 需要走專用流程還原的類型（帳戶餘額、關聯帳目要一起回復）；沒有值就是單純的刪除／寫回修改前的樣子 */
  undo?: 'tx' | 'transfer' | 'settle' | 'trade' | 'txedit' | 'txdel' | 'setting' | 'category' | 'rec_confirm' | 'rec_delete' | 'debt_del' | 'dividend' | 'transfer_del';
  /** 還原時需要的額外參數（例如週期確認的日期） */
  arg?: string;
}
export interface AgentOpLog {
  id: string;
  at: number;
  summary: string;
  titles: string[];
  changes: Change[];
  undoneAt?: number;
}

/** 執行與還原都會動到的資料表（同一個 Dexie 交易） */
const TX_TABLES = [db.transactions, db.transfers, db.accounts, db.attachments, db.durables, db.budgets, db.budget_periods, db.recurring_rules, db.goals, db.rules,
  db.debts, db.people, db.stocks, db.stock_trades, db.settings, db.meta, db.categories, db.projects, db.tags, db.wishes, db.installments, db.dividends, db.watchlist];

/** 載入預覽模擬需要的資料（候選帳目＝近一年未刪除的） */
export async function loadAgentData(): Promise<AgentData> {
  const today = todayKey();
  const st = useSettings.getState();
  const [categories, accounts, budgets, recurring, goals, rules, debtRows, people, stockRows, prices, tradeRows, txs,
    projectRows, tagRows, wishRows, durableRows, transferRows, watchRows] = await Promise.all([
    db.categories.toArray(), db.accounts.toArray(), db.budgets.toArray(), db.recurring_rules.toArray(), db.goals.toArray(), db.rules.toArray(),
    db.debts.toArray(), db.people.toArray(), db.stocks.toArray(), db.price_cache.toArray(), db.stock_trades.toArray(),
    db.transactions.where('date').aboveOrEqual(addDays(today, -365)).toArray().then((rows) => rows.filter((t) => !t.deletedAt)), // 先整批讀再過濾：Dexie 的 .filter() 會逐筆走游標，上萬筆時慢很多
    db.projects.toArray(), db.tags.toArray(), db.wishes.toArray(), db.durables.toArray(),
    db.transfers.where('date').aboveOrEqual(addDays(today, -365)).toArray().then((rows) => rows.filter((t) => !t.deletedAt)),
    db.watchlist.toArray(),
  ]);
  const inbox = await loadInboxReadOnly().catch(() => []);
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
    debts: debtRows.filter((x) => !x.deletedAt).map((x) => ({ id: x.id, personName: personName.get(x.personId) ?? '', direction: x.direction, amountMinor: x.amountMinor, currency: x.currency, note: x.note, settled: x.settled, loanTxId: x.loanTxId, settleTransferId: x.settleTransferId })),
    stocks: stockRows.filter((x) => !x.deletedAt).map((x) => ({ id: x.id, symbol: x.symbol, name: x.name, market: x.market, currency: x.currency, assetType: x.assetType, lotSize: x.lotSize, priceDec: priceOf.get(x.id), taxRateDec: x.taxRateDec })), holdings,
    feeConfig: twFeeConfig(st.invest), defaultBrokerageId: st.invest.defaultBrokerageId || undefined,
    projects: projectRows.filter((x) => !x.deletedAt), tags: tagRows.map((t) => ({ id: t.id, name: t.name })),
    wishes: wishRows.filter((x) => !x.deletedAt), durables: durableRows.filter((x) => !x.deletedAt), transfers: transferRows,
    watchlist: watchRows.map((w) => ({ stockId: w.stockId, alerts: w.alerts.map((a) => ({ priceDec: a.priceDec, op: a.op, enabled: a.enabled })) })),
    inbox, travelProjectId: st.travelModeProjectId,
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

/** 把這次改動過的每一筆讀回 updatedAt 存進還原紀錄（還原前用來確認沒被改過） */
async function stampChanges(changes: Change[]): Promise<void> {
  for (const c of changes) c.stamp = ((await db.table(c.table).get(c.id)) as { updatedAt: number } | undefined)?.updatedAt ?? 0;
}

/** 標籤用名字找、沒有就建一個（執行時才寫入；還原不刪標籤，避免誤刪使用者後來也在用的） */
async function ensureTags(names: string[]): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of names.slice(0, 6)) {
    const name = raw.trim().slice(0, 20);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const exist = await db.tags.where('name').equals(name).first();
    if (exist) { ids.push(exist.id); continue; }
    const id = uid();
    const now = Date.now();
    await db.tags.add({ id, name, color: '#8E8E93', sort: await db.tags.count(), createdAt: now, updatedAt: now });
    ids.push(id);
  }
  return ids;
}

/** 把步驟裡的草稿 id（同一份計畫先建的分類／帳戶／專案）換成真實 id */
function remapOp(op: Op, rid: (id: string) => string): Op {
  const opt = (id?: string) => (id ? rid(id) : id);
  switch (op.kind) {
    case 'recat': return { ...op, categoryId: rid(op.categoryId) };
    case 'budget': return { ...op, input: { ...op.input, categoryId: rid(op.input.categoryId), projectId: rid(op.input.projectId) } };
    case 'recurring': return { ...op, input: { ...op.input, template: { ...op.input.template, accountId: opt(op.input.template.accountId), categoryId: opt(op.input.template.categoryId), projectId: opt(op.input.template.projectId) } } };
    case 'tx_edit': return { ...op, set: { ...op.set, accountId: opt(op.set.accountId), categoryId: opt(op.set.categoryId), projectId: opt(op.set.projectId) } };
    case 'goal': return { ...op, input: { ...op.input, linkedAccountIds: op.input.linkedAccountIds.map(rid) } };
    case 'goal_edit': return { ...op, set: { ...op.set, linkedAccountIds: op.set.linkedAccountIds?.map(rid) } };
    case 'tx': return { ...op, input: { ...op.input, accountId: rid(op.input.accountId), categoryId: rid(op.input.categoryId), projectId: opt(op.input.projectId) } };
    case 'transfer': return { ...op, input: { ...op.input, fromAccountId: rid(op.input.fromAccountId), toAccountId: rid(op.input.toAccountId) } };
    case 'debt': return { ...op, input: { ...op.input, accountId: opt(op.input.accountId) } };
    case 'settle': return { ...op, accountId: opt(op.accountId) };
    case 'trade': return { ...op, input: { ...op.input, accountId: rid(op.input.accountId), cashAccountId: rid(op.input.cashAccountId) } };
    case 'installment': return { ...op, input: { ...op.input, accountId: rid(op.input.accountId), categoryId: rid(op.input.categoryId) } };
    case 'dividend': return { ...op, input: { ...op.input, accountId: rid(op.input.accountId) } };
    case 'wish': return { ...op, input: { ...op.input, categoryId: opt(op.input.categoryId) } };
    case 'wish_decide': return { ...op, wishId: rid(op.wishId) };
    case 'durable_use': return { ...op, durableId: rid(op.durableId) };
    case 'durable_sell': return { ...op, durableId: rid(op.durableId), ...(op.income ? { income: { accountId: rid(op.income.accountId), categoryId: rid(op.income.categoryId) } } : {}) };
    case 'travel': return { ...op, projectId: op.projectId === null ? null : rid(op.projectId) };
    case 'inbox': return { ...op, entries: op.entries.map((e) => ({ ...e, drafts: e.drafts.map((dr) => ({ ...dr, accountId: rid(dr.accountId), categoryId: opt(dr.categoryId), projectId: opt(dr.projectId), toAccountId: opt(dr.toAccountId) })) })) };
    default: return op;
  }
}

/**
 * 執行計畫（只執行可執行、沒被擋下的步驟）。本機寫入全部在同一個交易裡：任何一步失敗，整批都不會寫入。
 * 收件匣操作需要向伺服器認領，放不進 Dexie 交易，在本機寫入完成後才處理。
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
  // 新建的分類／帳戶／專案先執行取得真實 id，再把後面步驟裡的草稿 id 換掉
  const creates = ops.filter((o) => o.op.kind === 'category' || o.op.kind === 'account' || o.op.kind === 'project');
  const inboxOps = ops.filter((o) => o.op.kind === 'inbox');
  const dbOps = [...creates, ...ops.filter((o) => o.op.kind !== 'category' && o.op.kind !== 'account' && o.op.kind !== 'project' && o.op.kind !== 'inbox')];
  const remap = new Map<string, string>();
  const rid = (id: string) => remap.get(id) ?? id;
  let travelApplied: string | null | undefined;
  await db.transaction('rw', TX_TABLES, async () => {
    for (const { op } of dbOps) {
      if (op.kind === 'category') {
        const row = await addCategory({ ...op.input, parentId: rid(op.input.parentId), icon: '🏷️', color: '#8E8E93' });
        remap.set(op.draftId, row.id);
        log.changes.push({ table: 'categories', id: row.id, stamp: 0, undo: 'category' });
        continue;
      }
      if (op.kind === 'account') {
        const row = await addAccount({ ...op.input, icon: accountTypeInfo(op.input.type).icon, color: '#0A84FF', includeInNetWorth: true, isLiability: op.input.type === 'credit' });
        remap.set(op.draftId, row.id);
        log.changes.push({ table: 'accounts', id: row.id, stamp: 0 });
        continue;
      }
      if (op.kind === 'project') {
        const id = await saveProject(op.input);
        remap.set(op.draftId, id);
        log.changes.push({ table: 'projects', id, stamp: 0 });
        continue;
      }
      const o = remapOp(op, rid);
      if (o.kind === 'recat') {
        for (const id of o.ids) {
          const t = await db.transactions.get(id);
          if (!t || t.deletedAt) continue;
          log.changes.push({ table: 'transactions', id, before: { categoryId: t.categoryId }, stamp: 0 });
          await db.transactions.update(id, { categoryId: o.categoryId, updatedAt: Date.now() });
        }
      } else if (o.kind === 'tx_edit') {
        const t = await db.transactions.get(o.id);
        if (!t || t.deletedAt) continue;
        log.changes.push({ table: 'transactions', id: t.id, before: { ...t }, stamp: 0, undo: 'txedit' });
        const next = inputOf(t);
        if (o.set.amountMinor !== undefined) next.amountMinor = o.set.amountMinor;
        if (o.set.categoryId) next.categoryId = o.set.categoryId;
        if (o.set.accountId) next.accountId = o.set.accountId;
        if (o.set.note !== undefined) next.note = o.set.note;
        if (o.set.date) { next.date = o.set.date; next.ts = new Date(`${o.set.date}T${new Date(t.ts).toTimeString().slice(0, 8)}`).getTime(); }
        if (o.set.projectId) next.projectId = o.set.projectId;
        if (o.set.tagNames !== undefined) next.tagIds = o.set.tagNames.length ? await ensureTags(o.set.tagNames) : [];
        if (o.set.excludeFromBudget !== undefined) next.excludeFromBudget = o.set.excludeFromBudget;
        if (o.set.excludeFromStats !== undefined) next.excludeFromStats = o.set.excludeFromStats;
        await updateTransaction(t.id, next);
      } else if (o.kind === 'tx_delete') {
        for (const id of o.ids) {
          const t = await db.transactions.get(id);
          if (!t || t.deletedAt) continue;
          log.changes.push({ table: 'transactions', id, stamp: 0, undo: 'txdel' });
          await deleteTransactions([id]);
        }
      } else if (o.kind === 'budget') {
        if (o.id) {
          const before = await db.budgets.get(o.id);
          if (!before) throw new Error('要調整的預算已不存在');
          log.changes.push({ table: 'budgets', id: o.id, before: { ...before }, stamp: 0 });
          await saveBudget(o.input, o.id);
        } else {
          const id = await saveBudget(o.input);
          log.changes.push({ table: 'budgets', id, stamp: 0 });
        }
      } else if (o.kind === 'goal') {
        const id = await saveGoal(o.input);
        log.changes.push({ table: 'goals', id, stamp: 0 });
      } else if (o.kind === 'goal_edit') {
        const before = await db.goals.get(o.goalId);
        if (!before) throw new Error('要修改的目標已不存在');
        log.changes.push({ table: 'goals', id: before.id, before: { ...before }, stamp: 0 });
        await db.goals.where('id').equals(o.goalId).modify((g) => {
          if (o.set.targetMinor !== undefined) g.targetMinor = o.set.targetMinor;
          if (o.set.deadline !== undefined) { if (o.set.deadline === null) delete g.deadline; else g.deadline = o.set.deadline; }
          if (o.set.linkedAccountIds) g.linkedAccountIds = o.set.linkedAccountIds;
          if (o.set.status) g.status = o.set.status;
          g.updatedAt = Date.now();
        });
      } else if (o.kind === 'goal_deposit') {
        const g = await db.goals.get(o.goalId);
        if (!g) throw new Error('要存入的目標已不存在');
        log.changes.push({ table: 'goals', id: g.id, before: { ...g }, stamp: 0 });
        await saveGoal({ ...stripRow(g), manualSavedMinor: g.manualSavedMinor + o.amountMinor }, g.id);
      } else if (o.kind === 'rule') {
        const id = uid();
        const now = Date.now();
        await db.rules.add({ ...o.input, id, hits: 0, createdAt: now, updatedAt: now });
        log.changes.push({ table: 'rules', id, stamp: 0 });
      } else if (o.kind === 'tx') {
        const { tagNames, split, ...rest } = o.input;
        const tagIds = tagNames?.length ? await ensureTags(tagNames) : undefined;
        // 旅遊模式：AI 記的帳預設歸入目前的旅遊專案（有明寫專案就照明的）
        const t = await addTransaction({ ...rest, ts: Date.now(), tagIds, projectId: rest.projectId ?? (travelApplied !== undefined ? travelApplied : useSettings.getState().travelModeProjectId) ?? undefined, ...(split ? { split: { myShareMinor: split.myShareMinor, debtIds: [] } } : {}) });
        log.changes.push({ table: 'transactions', id: t.id, stamp: 0, undo: 'tx' });
        if (split && t.amountMinor > split.myShareMinor) {
          // 分帳：全額先離開帳戶，對方欠我的差額記成一筆欠款（和記帳面板同一套流程）
          const person = await findOrCreatePerson(split.personName);
          const [debtId] = await addDebts([{ personId: person.id, direction: 'they_owe_me', amountMinor: t.amountMinor - split.myShareMinor, currency: t.currency, date: t.date, note: t.note || '分帳', transactionId: t.id, groupId: t.id }]);
          await db.transactions.update(t.id, { split: { myShareMinor: split.myShareMinor, debtIds: [debtId] }, updatedAt: Date.now() });
          log.changes.push({ table: 'debts', id: debtId, stamp: 0 });
        }
      } else if (o.kind === 'transfer') {
        const tr = await addTransfer({ fromAccountId: o.input.fromAccountId, toAccountId: o.input.toAccountId, fromAmountMinor: o.input.amountMinor, toAmountMinor: o.input.amountMinor, feeMinor: 0, date: o.input.date, ts: Date.now(), note: o.input.note });
        log.changes.push({ table: 'transfers', id: tr.id, stamp: 0, undo: 'transfer' });
      } else if (o.kind === 'transfer_delete') {
        for (const id of o.ids) {
          const t = await db.transfers.get(id);
          if (!t || t.deletedAt) continue;
          log.changes.push({ table: 'transfers', id, stamp: 0, undo: 'transfer_del' });
          await deleteTransfers([id]);
        }
      } else if (o.kind === 'debt') {
        const res = await addLoan({ ...o.input, ts: Date.now() });
        log.changes.push({ table: 'debts', id: res.debtId, stamp: 0 });
        if (res.txId) log.changes.push({ table: 'transactions', id: res.txId, stamp: 0, undo: 'tx' });
      } else if (o.kind === 'settle') {
        const before = await db.debts.get(o.debtId);
        if (!before || before.settled) throw new Error('這筆欠款已經結清或不存在');
        log.changes.push({ table: 'debts', id: before.id, before: { ...before }, stamp: 0, undo: 'settle' });
        await settleDebt(before.id, o.accountId);
      } else if (o.kind === 'debt_manage') {
        for (const debtId of o.debtIds) {
          const d = await db.debts.get(debtId);
          if (!d || d.deletedAt) continue;
          if (o.action === 'delete') {
            log.changes.push({ table: 'debts', id: d.id, before: { ...d }, stamp: 0, undo: 'debt_del' });
            for (const txId of [d.loanTxId, d.settleTransferId]) {
              if (!txId) continue;
              const t = await db.transactions.get(txId);
              if (t && !t.deletedAt) log.changes.push({ table: 'transactions', id: txId, stamp: 0, undo: 'txdel' });
            }
            await removeLoan(debtId);
          } else {
            if (!d.settled) continue;
            log.changes.push({ table: 'debts', id: d.id, before: { ...d }, stamp: 0 });
            if (d.settleTransferId) {
              const t = await db.transactions.get(d.settleTransferId);
              if (t && !t.deletedAt) log.changes.push({ table: 'transactions', id: d.settleTransferId, stamp: 0, undo: 'txdel' });
            }
            await unsettleDebt(debtId);
          }
        }
      } else if (o.kind === 'trade') {
        const stock = await db.stocks.get(o.input.stockId);
        if (!stock) throw new Error('標的不存在');
        const inv = useSettings.getState().invest;
        const t = await addTrade({
          stockId: o.input.stockId, accountId: o.input.accountId, type: o.input.side, date: o.input.date, ts: Date.now(), sharesDec: o.input.sharesDec, priceDec: o.input.priceDec,
          feeMinor: o.input.feeMinor, taxMinor: o.input.taxMinor, fxRateDec: '1', isDCA: false, syncToLedger: true, cashAccountId: o.input.cashAccountId, note: '由 Cilo 操作助手記錄', costMethodSnapshot: inv.costMethod,
        });
        log.changes.push({ table: 'stock_trades', id: t.id, stamp: 0, undo: 'trade' });
      } else if (o.kind === 'travel') {
        const prev = await db.settings.get('travelModeProjectId');
        log.changes.push({ table: 'settings', id: 'travelModeProjectId', before: { value: prev?.value ?? null }, stamp: 0, undo: 'setting' });
        await saveSetting('travelModeProjectId', o.projectId);
        travelApplied = o.projectId;
      } else if (o.kind === 'installment') {
        const id = await addInstallment(o.input);
        log.changes.push({ table: 'installments', id, stamp: 0 });
        const row = await db.installments.get(id);
        for (const item of row?.schedule ?? []) {
          if (item.transactionId) log.changes.push({ table: 'transactions', id: item.transactionId, stamp: 0, undo: 'tx' });
        }
      } else if (o.kind === 'recurring_manage') {
        const before = await db.recurring_rules.get(o.ruleId);
        if (!before) throw new Error('這筆週期帳目已不存在');
        if (o.action === 'delete') {
          log.changes.push({ table: 'recurring_rules', id: before.id, before: { ...before }, stamp: 0, undo: 'rec_delete' });
          await db.recurring_rules.delete(before.id);
        } else if (o.action === 'confirm') {
          if (!o.date) throw new Error('沒有指定要確認的期數');
          log.changes.push({ table: 'recurring_rules', id: before.id, before: { ...before }, stamp: 0, undo: 'rec_confirm', arg: o.date });
          await confirmPending(before.id, o.date, o.amountMinor);
        } else if (o.action === 'skip') {
          if (!o.date) throw new Error('沒有指定要略過的期數');
          log.changes.push({ table: 'recurring_rules', id: before.id, before: { ...before }, stamp: 0 });
          await skipPending(before.id, o.date);
        } else if (o.action === 'pause' || o.action === 'resume') {
          log.changes.push({ table: 'recurring_rules', id: before.id, before: { ...before }, stamp: 0 });
          await db.recurring_rules.update(before.id, { active: o.action === 'pause' ? 0 : 1, updatedAt: Date.now() });
        } else {
          log.changes.push({ table: 'recurring_rules', id: before.id, before: { ...before }, stamp: 0 });
          await saveRecurring({
            ...stripRow(before),
            template: { ...before.template, ...(o.amountMinor !== undefined ? { amountMinor: o.amountMinor } : {}) },
            rule: o.day !== undefined ? { ...before.rule, byMonthDay: o.day } : before.rule,
            mode: o.mode ?? before.mode,
          }, before.id);
        }
      } else if (o.kind === 'dividend') {
        const id = await saveDividend(o.input);
        log.changes.push({ table: 'dividends', id, stamp: 0, undo: 'dividend' });
      } else if (o.kind === 'wish') {
        const id = await addWish(o.input);
        remap.set(o.draftId, id);
        log.changes.push({ table: 'wishes', id, stamp: 0 });
      } else if (o.kind === 'wish_decide') {
        const before = await db.wishes.get(o.wishId);
        if (!before) throw new Error('這個願望已不存在');
        log.changes.push({ table: 'wishes', id: before.id, before: { ...before }, stamp: 0 });
        if (o.decision === 'extend') await extendWish(before.id, 7);
        else await decideWish(before.id, o.decision);
      } else if (o.kind === 'durable_add') {
        const row = await addDurable({ ...o.input, icon: '📦' });
        remap.set(o.draftId, row.id);
        log.changes.push({ table: 'durables', id: row.id, stamp: 0 });
      } else if (o.kind === 'durable_use') {
        const before = await db.durables.get(o.durableId);
        if (!before) throw new Error('這件物品已不存在');
        log.changes.push({ table: 'durables', id: before.id, before: { ...before }, stamp: 0 });
        await addUse(before.id, 1);
      } else if (o.kind === 'durable_sell') {
        const before = await db.durables.get(o.durableId);
        if (!before || before.status !== 'active') throw new Error('這件物品已經處理過了');
        log.changes.push({ table: 'durables', id: before.id, before: { ...before }, stamp: 0 });
        const res = await sellDurable({ id: before.id, endDate: o.endDate, saleMinor: o.saleMinor, income: o.income });
        if (res.saleTx) log.changes.push({ table: 'transactions', id: res.saleTx.id, stamp: 0, undo: 'tx' });
      } else if (o.kind === 'watch') {
        const existing = await db.watchlist.where('stockId').equals(o.stockId).first();
        if (o.priceDec && o.op) {
          const alert = { op: o.op, priceDec: o.priceDec, enabled: true };
          if (existing) {
            log.changes.push({ table: 'watchlist', id: existing.id, before: { ...existing }, stamp: 0 });
            await updateAlerts(existing.id, [...existing.alerts, alert]);
          } else {
            await addWatch(o.stockId);
            const row = await db.watchlist.where('stockId').equals(o.stockId).first();
            if (row) {
              log.changes.push({ table: 'watchlist', id: row.id, stamp: 0 });
              await updateAlerts(row.id, [alert]);
            }
          }
        } else if (!existing) {
          await addWatch(o.stockId);
          const row = await db.watchlist.where('stockId').equals(o.stockId).first();
          if (row) log.changes.push({ table: 'watchlist', id: row.id, stamp: 0 });
        }
      } else if (o.kind === 'recurring') {
        const id = await saveRecurring(o.input);
        log.changes.push({ table: 'recurring_rules', id, stamp: 0 });
      }
    }
    await stampChanges(log.changes);
  });
  // 收件匣：本機入帳成功後才向伺服器認領（交易外）；記下的帳目仍可透過紀錄還原
  for (const { op } of inboxOps) {
    const o = remapOp(op, rid) as Extract<Op, { kind: 'inbox' }>;
    if (o.action === 'skip') {
      await ackInbox(o.entries.map((e) => e.item.id)).catch(() => []);
      continue;
    }
    const res = await bookInboxEntries(o.entries, { skipDuplicates: true });
    for (const id of res.txIds) log.changes.push({ table: 'transactions', id, stamp: 0, undo: 'tx' });
    for (const id of res.transferIds) log.changes.push({ table: 'transfers', id, stamp: 0, undo: 'transfer' });
  }
  if (inboxOps.length) {
    await stampChanges(log.changes);
    invalidateInboxReadOnly();
  }
  await db.meta.put({ key: OPS_KEY, value: [...(await readLog()), log] });
  if (travelApplied !== undefined) {
    useSettings.setState({ travelModeProjectId: travelApplied });
    applyTheme(useSettings.getState());
  }
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
  let travelRestored: string | null | undefined;
  await db.transaction('rw', TX_TABLES, async () => {
    const all = await readLog();
    const log = all.find((l) => l.id === id);
    if (!log) throw new Error('找不到這筆操作紀錄（可能已超過 7 天）');
    if (log.undoneAt) throw new Error('這筆操作已經還原過了');
    // 同一份計畫裡同一筆可能被改了好幾次（或先建後動）：還原時先處理後面的改動，
    // 會把 updatedAt 寫新，讓前面那筆的「有沒有被改過」檢查誤判。記下這次還原動過的列，略過檢查。
    const touched = new Set<string>();
    const markTx = async (txId?: string) => {
      if (!txId) return;
      const t = await db.transactions.get(txId);
      if (!t) return;
      touched.add(`accounts:${t.accountId}`);
      for (const d of await db.durables.where('txId').equals(txId).toArray()) touched.add(`durables:${d.id}`);
      for (const d of await db.durables.filter((x) => x.saleTxId === txId).toArray()) touched.add(`durables:${d.id}`);
    };
    const markTransfer = async (trId: string) => {
      const t = await db.transfers.get(trId);
      if (!t) return;
      touched.add(`accounts:${t.fromAccountId}`);
      touched.add(`accounts:${t.toAccountId}`);
      if (t.feeAccountId) touched.add(`accounts:${t.feeAccountId}`);
    };
    for (const c of [...log.changes].reverse()) {
      const key = `${c.table}:${c.id}`;
      // 設定列沒有 updatedAt、硬刪除的列讀不回來：這兩種跳過「有沒有被改過」檢查直接寫回
      if (c.undo === 'setting') {
        await db.settings.put({ key: c.id, value: c.before?.value ?? null });
        if (c.id === 'travelModeProjectId') travelRestored = (c.before?.value ?? null) as string | null;
        touched.add(key);
        res.restored++;
        continue;
      }
      if ((c.undo === 'rec_delete' || c.undo === 'debt_del') && c.before) {
        await db.table(c.table).put({ ...c.before, updatedAt: Date.now() });
        touched.add(key);
        res.restored++;
        continue;
      }
      const cur = (await db.table(c.table).get(c.id)) as { updatedAt: number } | undefined;
      const inPass = touched.has(key);
      if (!cur) {
        // 列已經不在：這次還原裡先前的步驟已處理掉（例如先建後刪）就算還原成功
        if (inPass) res.restored++; else res.skipped++;
        continue;
      }
      if (!inPass && cur.updatedAt !== c.stamp) { res.skipped++; continue; }
      if (c.undo === 'tx') { await markTx(c.id); await deleteTransactions([c.id]); }
      else if (c.undo === 'transfer') { await markTransfer(c.id); await deleteTransfers([c.id]); }
      else if (c.undo === 'transfer_del') { await markTransfer(c.id); await restoreTransfers([c.id]); }
      else if (c.undo === 'settle') { await markTx((await db.debts.get(c.id))?.settleTransferId); await unsettleDebt(c.id); }
      else if (c.undo === 'trade') {
        const t = await db.stock_trades.get(c.id);
        if (t) {
          touched.add(`accounts:${t.accountId}`);
          if (t.cashAccountId) touched.add(`accounts:${t.cashAccountId}`);
          await markTx(t.transactionId);
          await markTx(t.feeTransactionId);
        }
        await deleteTrade(c.id);
      } else if (c.undo === 'dividend') { await markTx((await db.dividends.get(c.id))?.transactionId); await deleteDividend(c.id); }
      else if (c.undo === 'category') await deleteOrArchiveCategory(c.id);
      else if (c.undo === 'rec_confirm' && c.before) {
        await markTx(`rec-${c.id}-${c.arg}`);
        await deleteTransactions([`rec-${c.id}-${c.arg}`]);
        await db.table(c.table).put({ ...c.before, updatedAt: Date.now() });
      } else if (c.undo === 'txedit' && c.before) {
        const b = c.before as unknown as Transaction;
        await markTx(c.id);
        touched.add(`accounts:${b.accountId}`);
        // updateTransaction 會略過 undefined 欄位：明確給 false 才能把「不計入預算」還原掉
        await updateTransaction(c.id, { ...inputOf(b), excludeFromBudget: b.excludeFromBudget ?? false });
      } else if (c.undo === 'txdel') { await markTx(c.id); await restoreTransactions([c.id]); }
      else if (c.before === undefined) {
        if (c.table === 'budgets') await deleteBudget(c.id);
        else await db.table(c.table).delete(c.id);
      } else if (c.table === 'transactions') {
        await db.transactions.update(c.id, { ...c.before, updatedAt: Date.now() });
      } else {
        await db.table(c.table).put({ ...c.before, updatedAt: Date.now() });
      }
      touched.add(key);
      res.restored++;
    }
    log.undoneAt = Date.now();
    await db.meta.put({ key: OPS_KEY, value: all });
  });
  if (travelRestored !== undefined) {
    useSettings.setState({ travelModeProjectId: travelRestored });
    applyTheme(useSettings.getState());
  }
  invalidateAutocat();
  return res;
}

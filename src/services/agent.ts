/**
 * 操作助手的執行層：載入模擬所需資料、把計畫真的寫入（單一 Dexie 交易＝要嘛全成功要嘛全不動）、
 * 並為每次執行留下「修改前的樣子」，讓使用者一鍵還原。
 *
 * 還原紀錄存在本機 meta 表（不同步），保留 7 天、最多 20 筆。還原時逐筆檢查：那一筆在執行後又被改過
 * （updatedAt 不同）就不動它並告知，避免蓋掉使用者之後的修改。寫回時間戳更新，所以其他裝置同步時也會跟著還原。
 */
import { db, uid } from '@/db/schema';
import { deleteBudget, saveBudget, saveGoal, saveRecurring } from '@/db/repo/plan';
import { invalidateAutocat } from './autocat';
import { resolvePlan, type AgentData, type Op, type RawStep, type ResolvedStep } from '@/domain/agent/plan';
import { addDays, todayKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';

const OPS_KEY = 'agent.ops';
const KEEP_DAYS = 7;
const KEEP_N = 20;

type Table = 'transactions' | 'budgets' | 'recurring_rules' | 'goals' | 'rules';
interface Change {
  table: Table;
  id: string;
  /** undefined＝這次新增的（還原時刪除）；否則是修改前要寫回的欄位／整列 */
  before?: Record<string, unknown>;
  /** 執行後的 updatedAt：還原前用來確認沒被改過 */
  stamp: number;
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
  const [categories, accounts, budgets, recurring, goals, rules, txs] = await Promise.all([
    db.categories.toArray(), db.accounts.toArray(), db.budgets.toArray(), db.recurring_rules.toArray(), db.goals.toArray(), db.rules.toArray(),
    db.transactions.where('date').aboveOrEqual(addDays(today, -365)).toArray().then((rows) => rows.filter((t) => !t.deletedAt)), // 先整批讀再過濾：Dexie 的 .filter() 會逐筆走游標，上萬筆時慢很多
  ]);
  return { today, baseCurrency: st.baseCurrency, monthStartDay: st.monthStartDay, categories, accounts, budgets, recurring, goals, rules, txs, defaultAccountId: st.lastAccountId || undefined };
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
export async function applyPlan(steps: ResolvedStep[], summary: string): Promise<AgentOpLog> {
  const ops = steps.filter((s) => !s.preview.blocked && s.op).map((s) => ({ op: s.op as Op, title: s.preview.title }));
  if (!ops.length) throw new Error('沒有可以執行的步驟');
  const log: AgentOpLog = { id: uid(), at: Date.now(), summary: summary || ops[0].title, titles: ops.map((o) => o.title), changes: [] };
  await db.transaction('rw', [db.transactions, db.budgets, db.budget_periods, db.recurring_rules, db.goals, db.rules, db.meta], async () => {
    for (const { op } of ops) {
      if (op.kind === 'recat') {
        for (const id of op.ids) {
          const t = await db.transactions.get(id);
          if (!t || t.deletedAt) continue;
          log.changes.push({ table: 'transactions', id, before: { categoryId: t.categoryId }, stamp: 0 });
          await db.transactions.update(id, { categoryId: op.categoryId, updatedAt: Date.now() });
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
      } else if (op.kind === 'rule') {
        const id = uid();
        const now = Date.now();
        await db.rules.add({ ...op.input, id, hits: 0, createdAt: now, updatedAt: now });
        log.changes.push({ table: 'rules', id, stamp: 0 });
      } else {
        const id = await saveRecurring(op.input);
        log.changes.push({ table: 'recurring_rules', id, stamp: 0 });
      }
    }
    for (const c of log.changes) c.stamp = ((await db.table(c.table).get(c.id)) as { updatedAt: number } | undefined)?.updatedAt ?? 0;
    await db.meta.put({ key: OPS_KEY, value: [...(await readLog()), log] });
  });
  if (log.changes.some((c) => c.table === 'rules')) invalidateAutocat();
  return log;
}

export interface UndoResult { restored: number; skipped: number }

/** 一鍵還原：把這次執行改的、建的全部復原；執行後又被改過的那幾筆不動並回報 */
export async function undoOp(id: string): Promise<UndoResult> {
  const res: UndoResult = { restored: 0, skipped: 0 };
  await db.transaction('rw', [db.transactions, db.budgets, db.budget_periods, db.recurring_rules, db.goals, db.rules, db.meta], async () => {
    const all = await readLog();
    const log = all.find((l) => l.id === id);
    if (!log) throw new Error('找不到這筆操作紀錄（可能已超過 7 天）');
    if (log.undoneAt) throw new Error('這筆操作已經還原過了');
    for (const c of [...log.changes].reverse()) {
      const cur = (await db.table(c.table).get(c.id)) as { updatedAt: number } | undefined;
      if (!cur || cur.updatedAt !== c.stamp) { res.skipped++; continue; }
      if (c.before === undefined) {
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

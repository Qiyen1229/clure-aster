/**
 * 階段 2 資料存取：預算、專案、週期／訂閱、分期、分帳、存錢目標、已存篩選。
 * 「開啟 App 時補算」：processRecurring / processInstallments 會把到期但尚未入帳的期數補齊
 * （iOS PWA 無法在背景執行，這是唯一可靠的做法）。
 */
import { db, uid } from '../schema';
import type {
  Budget, Debt, Goal, Installment, Person, Project, RecurringRule, SavedFilter, Transaction, TxFilter, Wish,
} from '../types';
import { addTransaction, deleteTransactions, type TxInput } from './ledger';
import { budgetPeriod, budgetStatus, periodsUntil, rolloverChain, type BudgetStatus } from '@/domain/budget';
import { nextAfter, occurrences } from '@/domain/recurrence';
import { buildSchedule, periodTotal } from '@/domain/installment';
import { statAmount } from '@/domain/ledger';
import { convertMinor } from '@/domain/money';
import { todayKey, type Range } from '@/domain/period';
import { resolveRate } from '@/services/fx';
import { getSetting } from './settings';

const now = () => Date.now();

// ───────────── 預算 ─────────────

export type BudgetInput = Omit<Budget, 'id' | 'createdAt' | 'updatedAt'>;

export async function saveBudget(input: BudgetInput, id?: string): Promise<string> {
  if (id) { await db.budgets.update(id, { ...input, updatedAt: now() }); return id; }
  const row: Budget = { ...input, id: uid(), createdAt: now(), updatedAt: now() };
  await db.budgets.add(row);
  return row.id;
}

export async function deleteBudget(id: string) {
  await db.budgets.delete(id);
  await db.budget_periods.where('budgetId').equals(id).delete();
}

/** 預算是否涵蓋這筆帳目 */
function budgetMatcher(b: Budget, catChildren: Map<string, Set<string>>) {
  const cats = b.categoryId ? catChildren.get(b.categoryId) ?? new Set([b.categoryId]) : null;
  return (t: Transaction) =>
    !t.deletedAt && (t.type === 'expense' || t.type === 'transfer_fee') && !t.excludeFromStats && !t.excludeFromBudget &&
    (!cats || cats.has(t.categoryId)) && (!b.projectId || t.projectId === b.projectId);
}

async function categoryChildren(): Promise<Map<string, Set<string>>> {
  const cats = await db.categories.toArray();
  const map = new Map<string, Set<string>>();
  for (const c of cats) {
    const root = c.parentId || c.id;
    if (!map.has(root)) map.set(root, new Set([root]));
    map.get(root)!.add(c.id);
    if (!map.has(c.id)) map.set(c.id, new Set([c.id]));
  }
  return map;
}

export interface BudgetView {
  budget: Budget;
  period: Range;
  status: BudgetStatus;
  carryIn: number;
  history: { period: Range; limit: number; spent: number }[];
}

export async function computeBudgets(today = todayKey()): Promise<BudgetView[]> {
  const [budgets, monthStartDay, weekStart, children] = await Promise.all([
    db.budgets.toArray(), getSetting('monthStartDay'), getSetting('weekStart'), categoryChildren(),
  ]);
  const opts = { monthStartDay, weekStart };
  const out: BudgetView[] = [];
  for (const b of budgets.filter((x) => x.active)) {
    const periods = b.rollover ? periodsUntil(b, today, opts, 24) : [budgetPeriod(b, today, opts)];
    const first = periods[0].start;
    const last = periods[periods.length - 1].end;
    const match = budgetMatcher(b, children);
    const txs = (await db.transactions.where('date').between(first, last, true, true).toArray()).filter(match);
    const spent = periods.map((p) => txs.filter((t) => t.date >= p.start && t.date <= p.end).reduce((a, t) => a + statAmount(t), 0));
    const chain = rolloverChain(b.amountMinor, spent, b.rollover);
    const i = periods.length - 1;
    const spentToday = txs.filter((t) => t.date === today).reduce((a, t) => a + statAmount(t), 0);
    out.push({
      budget: b,
      period: periods[i],
      carryIn: chain[i].carryIn,
      status: budgetStatus(chain[i].limit, spent[i], periods[i], today, b.alertPercents[0] ?? 80, spentToday),
      history: periods.map((p, k) => ({ period: p, limit: chain[k].limit, spent: spent[k] })),
    });
  }
  // 總預算排最前，其次依使用率
  return out.sort((a, b) => (a.budget.categoryId ? 1 : 0) - (b.budget.categoryId ? 1 : 0) || b.status.pct - a.status.pct);
}

// ───────────── 專案 ─────────────

export async function saveProject(input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>, id?: string): Promise<string> {
  if (id) { await db.projects.update(id, { ...input, updatedAt: now() }); return id; }
  const row: Project = { ...input, id: uid(), createdAt: now(), updatedAt: now() };
  await db.projects.add(row);
  return row.id;
}

/** 刪除專案：帳目保留，只移除專案關聯 */
export async function deleteProject(id: string) {
  await db.transaction('rw', db.projects, db.transactions, db.transfers, async () => {
    await db.transactions.where('projectId').equals(id).modify((t) => { delete t.projectId; });
    await db.transfers.filter((t) => t.projectId === id).modify((t) => { delete t.projectId; });
    await db.projects.delete(id);
  });
}

export async function projectStats(project: Project) {
  const txs = (await db.transactions.where('projectId').equals(project.id).toArray()).filter((t) => !t.deletedAt && t.type !== 'adjust' && !t.excludeFromStats);
  const base = await getSetting('baseCurrency');
  const rates = new Map((await db.exchange_rates.toArray()).map((r) => [`${r.base}>${r.quote}`, r]));
  const rateBaseToProject = project.currency === base ? null : resolveRate(rates, base, project.currency);
  // 以專案幣別計：同幣別直接用原幣金額，否則由主幣別換算
  const inProject = (t: Transaction) => {
    if (t.currency === project.currency) return t.split ? Math.round((t.amountMinor * t.split.myShareMinor) / t.amountMinor) : t.amountMinor;
    if (project.currency === base) return statAmount(t);
    return rateBaseToProject ? convertMinor(statAmount(t), base, project.currency, rateBaseToProject) : 0;
  };
  let expense = 0, income = 0, expenseBase = 0;
  const byCat = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const t of txs) {
    const v = inProject(t);
    if (t.type === 'income') income += v;
    else {
      expense += v;
      expenseBase += statAmount(t);
      byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + v);
      byDay.set(t.date, (byDay.get(t.date) ?? 0) + v);
    }
  }
  return { txs, expense, income, expenseBase, byCat, byDay, base };
}

// ───────────── 週期／訂閱 ─────────────

export type RecurringInput = Pick<RecurringRule, 'kind' | 'name' | 'template' | 'rule' | 'startDate' | 'mode' | 'remindDaysBefore' | 'subscription' | 'active'>;

export async function saveRecurring(input: RecurringInput, id?: string): Promise<string> {
  const today = todayKey();
  if (id) {
    const old = await db.recurring_rules.get(id);
    if (!old) throw new Error('規則不存在');
    const ruleChanged = JSON.stringify(old.rule) !== JSON.stringify(input.rule) || old.startDate !== input.startDate;
    const nextDue = ruleChanged
      ? (input.startDate > today ? input.startDate : nextAfter(input.rule, input.startDate, old.nextDue < today ? today : old.nextDue) ?? old.nextDue)
      : old.nextDue;
    await db.recurring_rules.update(id, { ...input, nextDue, updatedAt: now() });
    return id;
  }
  const row: RecurringRule = { ...input, id: uid(), nextDue: input.startDate, doneCount: 0, pendingDates: [], createdAt: now(), updatedAt: now() };
  await db.recurring_rules.add(row);
  return row.id;
}

function templateToInput(r: RecurringRule, date: string): TxInput {
  const t = r.template;
  return {
    type: (t.type as TxInput['type']) ?? 'expense',
    accountId: t.accountId!, categoryId: t.categoryId!, amountMinor: t.amountMinor!, currency: t.currency!,
    date, ts: new Date(`${date}T09:00:00`).getTime(), note: t.note || r.name, tagIds: t.tagIds ?? [], projectId: t.projectId,
    recurringRuleId: r.id,
  };
}

/** 補齊到期的週期帳目；回傳新入帳數與待確認數 */
export async function processRecurring(today = todayKey()): Promise<{ created: number; pending: number }> {
  const rules = await db.recurring_rules.where('nextDue').belowOrEqual(today).toArray();
  let created = 0, pending = 0;
  for (const r of rules) {
    if (!r.active) continue;
    if (!r.template.accountId || !(await db.accounts.get(r.template.accountId))) continue;
    const due = occurrences(r.rule, r.startDate, r.nextDue, today, 400);
    const pend = [...r.pendingDates];
    for (const d of due) {
      if (r.mode === 'auto') {
        try { await addTransaction(templateToInput(r, d)); created++; } catch (e) { console.warn('[recurring]', e); break; }
      } else if (!pend.includes(d)) { pend.push(d); pending++; }
    }
    const lastDone = due[due.length - 1] ?? r.nextDue;
    const next = nextAfter(r.rule, r.startDate, due.length ? lastDone : addDaysSafe(r.nextDue, -1));
    await db.recurring_rules.update(r.id, {
      nextDue: next ?? '9999-12-31', doneCount: r.doneCount + due.length, pendingDates: pend,
      active: next ? 1 : 0, updatedAt: now(),
    });
  }
  return { created, pending };
}

function addDaysSafe(d: string, n: number) {
  const x = new Date(`${d}T00:00:00`);
  x.setDate(x.getDate() + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

export async function confirmPending(ruleId: string, date: string, amountMinor?: number) {
  const r = await db.recurring_rules.get(ruleId);
  if (!r) return;
  const input = templateToInput(r, date);
  if (amountMinor) input.amountMinor = amountMinor;
  await addTransaction(input);
  await db.recurring_rules.update(ruleId, { pendingDates: r.pendingDates.filter((d) => d !== date) });
  if (r.kind === 'subscription' && amountMinor && amountMinor !== r.template.amountMinor) {
    // 訂閱漲價：更新範本並記錄價格歷史
    await db.recurring_rules.update(ruleId, {
      template: { ...r.template, amountMinor },
      subscription: { ...(r.subscription ?? { service: r.name, priceHistory: [] }), priceHistory: [...(r.subscription?.priceHistory ?? []), { date, amountMinor }] },
    });
  }
}

export async function skipPending(ruleId: string, date: string) {
  const r = await db.recurring_rules.get(ruleId);
  if (r) await db.recurring_rules.update(ruleId, { pendingDates: r.pendingDates.filter((d) => d !== date) });
}

// ───────────── 分期 ─────────────

export type InstallmentInput = Pick<Installment, 'name' | 'accountId' | 'categoryId' | 'principalMinor' | 'currency' | 'periods' | 'aprDec' | 'feeMinor' | 'feeMode' | 'firstDate'>;

export async function addInstallment(input: InstallmentInput): Promise<string> {
  const schedule = buildSchedule(input);
  const row: Installment = { ...input, id: uid(), schedule, status: 'active', createdAt: now(), updatedAt: now() };
  await db.installments.add(row);
  await processInstallments();
  return row.id;
}

/** 到期期數自動拆成帳目 */
export async function processInstallments(today = todayKey()): Promise<number> {
  const list = await db.installments.where('status').equals('active').toArray();
  let created = 0;
  for (const inst of list) {
    const schedule = [...inst.schedule];
    let changed = false;
    for (const item of schedule) {
      if (item.transactionId || item.date > today) continue;
      if (!(await db.accounts.get(inst.accountId))) break;
      const tx = await addTransaction({
        type: 'expense', accountId: inst.accountId, categoryId: inst.categoryId, amountMinor: periodTotal(item),
        currency: inst.currency, date: item.date, ts: new Date(`${item.date}T08:00:00`).getTime(),
        note: `${inst.name}（分期 ${item.no}/${inst.periods}）`, installmentId: inst.id, installmentNo: item.no,
      });
      item.transactionId = tx.id;
      changed = true;
      created++;
    }
    if (changed) {
      await db.installments.update(inst.id, { schedule, status: schedule.every((s) => s.transactionId) ? 'done' : 'active', updatedAt: now() });
    }
  }
  return created;
}

/** 刪除分期：已入帳的帳目保留，未到期的期數取消 */
export async function deleteInstallment(id: string) {
  await db.installments.delete(id);
}

// ───────────── 分帳／代墊 ─────────────

export async function findOrCreatePerson(name: string): Promise<Person> {
  const n = name.trim();
  const exist = await db.people.where('name').equals(n).first();
  if (exist) return exist;
  const p: Person = { id: uid(), name: n, createdAt: now(), updatedAt: now() };
  await db.people.add(p);
  return p;
}

export async function addDebts(rows: Omit<Debt, 'id' | 'createdAt' | 'updatedAt' | 'settled'>[]): Promise<string[]> {
  const full: Debt[] = rows.map((r) => ({ ...r, id: uid(), settled: 0, createdAt: now(), updatedAt: now() }));
  await db.debts.bulkAdd(full);
  return full.map((d) => d.id);
}

export interface LoanInput {
  direction: Debt['direction'];
  personName: string;
  amountMinor: number;
  currency: string;
  date: string;
  ts: number;
  note: string;
  /** 有值：借出（錢從此帳戶付出）／借入（錢存入此帳戶）；沒有值：只記錄欠款，不動帳戶 */
  accountId?: string;
  /** 只記錄「我欠對方」且不動帳戶時：還款時要記入的支出分類 */
  categoryId?: string;
}

/**
 * 應收／應付帳款（記帳面板）：
 * - 應收（they_owe_me）＋帳戶 = 借出：帳戶扣款，記為「借出／還款」，不計入收支與預算
 * - 應付（i_owe_them）＋帳戶 = 借入：帳戶入帳，記為「借入／收款」，不計入收支與預算
 * - 不選帳戶：只建立欠款紀錄，結清時再記帳
 */
export async function addLoan(input: LoanInput): Promise<{ debtId: string; txId?: string }> {
  const person = await findOrCreatePerson(input.personName);
  let txId: string | undefined;
  if (input.accountId) {
    const out = input.direction === 'they_owe_me';
    const tx = await addTransaction({
      type: out ? 'expense' : 'income', accountId: input.accountId, categoryId: out ? 'sys-debt-out' : 'sys-debt-in',
      amountMinor: input.amountMinor, currency: input.currency, date: input.date, ts: input.ts,
      note: `${out ? '借給' : '向'} ${person.name}${out ? '' : ' 借入'}${input.note ? `：${input.note}` : ''}`,
      excludeFromStats: true, excludeFromBudget: true,
    });
    txId = tx.id;
  }
  const [debtId] = await addDebts([{
    personId: person.id, direction: input.direction, amountMinor: input.amountMinor, currency: input.currency,
    date: input.date, note: input.note, loanTxId: txId,
    categoryId: input.direction === 'i_owe_them' && !txId ? input.categoryId : undefined,
  }]);
  return { debtId, txId };
}

/** 復原 addLoan：刪除欠款與帳目 */
export async function removeLoan(debtId: string) {
  const d = await db.debts.get(debtId);
  if (!d) return;
  if (d.settleTransferId) await deleteTransactions([d.settleTransferId]);
  if (d.loanTxId) await deleteTransactions([d.loanTxId]);
  await db.debts.delete(debtId);
}

/**
 * 結清：可選擇記錄到帳戶。
 * - 借出／借入（loanTxId 有值）：現金當初已流動 → 收回／還款都不計入收支與預算
 * - 對方還我：收入（不計入收支統計，因為原本的支出已只算我的份額）
 * - 我還對方：支出（計入統計，分類用債務上的分類）
 */
export async function settleDebt(id: string, accountId?: string) {
  const d = await db.debts.get(id);
  if (!d || d.settled) return;
  let txId: string | undefined;
  if (accountId) {
    const person = await db.people.get(d.personId);
    const theyPay = d.direction === 'they_owe_me';
    const loan = !!d.loanTxId;
    const tx = await addTransaction({
      type: theyPay ? 'income' : 'expense',
      accountId,
      categoryId: loan ? (theyPay ? 'sys-debt-in' : 'sys-debt-out') : theyPay ? 'inc-refund' : d.categoryId || 'exp-other_exp',
      amountMinor: d.amountMinor, currency: d.currency, date: todayKey(), ts: Date.now(),
      note: `${theyPay ? '收回' : '還給'} ${person?.name ?? ''}${d.note ? `：${d.note}` : ''}`,
      excludeFromStats: theyPay || loan,
      excludeFromBudget: loan || undefined,
    });
    txId = tx.id;
  }
  await db.debts.update(id, { settled: 1, settledAt: now(), settleTransferId: txId, updatedAt: now() });
}

/** 取消結清：若結清時有入帳，一併刪除（軟刪除）該筆帳目，帳戶餘額回復，避免再次結清時重複入帳 */
export async function unsettleDebt(id: string) {
  const d = await db.debts.get(id);
  if (!d) return;
  if (d.settleTransferId) await deleteTransactions([d.settleTransferId]);
  await db.debts.update(id, { settled: 0, settledAt: undefined, settleTransferId: undefined, updatedAt: now() });
}

// ───────────── 存錢目標 ─────────────

export async function saveGoal(input: Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>, id?: string): Promise<string> {
  if (id) { await db.goals.update(id, { ...input, updatedAt: now() }); return id; }
  const row: Goal = { ...input, id: uid(), createdAt: now(), updatedAt: now() };
  await db.goals.add(row);
  return row.id;
}

/** 目前已存金額：連結帳戶餘額合計（換算為目標幣別）＋手動存入 */
export async function goalSaved(goal: Goal): Promise<number> {
  let total = goal.manualSavedMinor;
  if (goal.linkedAccountIds.length) {
    const accs = (await db.accounts.bulkGet(goal.linkedAccountIds)).filter(Boolean);
    const rates = new Map((await db.exchange_rates.toArray()).map((r) => [`${r.base}>${r.quote}`, r]));
    for (const a of accs) {
      if (a!.currency === goal.currency) total += a!.balanceMinor;
      else {
        const r = resolveRate(rates, a!.currency, goal.currency);
        if (r) total += convertMinor(a!.balanceMinor, a!.currency, goal.currency, r);
      }
    }
  }
  return total;
}

// ───────────── 已存篩選 ─────────────

export async function saveFilter(name: string, filter: TxFilter): Promise<string> {
  const count = await db.saved_filters.count();
  const row: SavedFilter = { id: uid(), name, filter, sort: count, createdAt: now(), updatedAt: now() };
  await db.saved_filters.add(row);
  return row.id;
}

/** 套用進階篩選（純記憶體過濾，資料已先依日期區間縮小） */
export function matchFilter(t: Transaction, f: TxFilter, catChildren?: Map<string, Set<string>>): boolean {
  if (f.types?.length && !f.types.includes(t.type)) return false;
  if (f.accountIds?.length && !f.accountIds.includes(t.accountId)) return false;
  if (f.categoryIds?.length) {
    const ok = f.categoryIds.some((c) => (catChildren?.get(c) ?? new Set([c])).has(t.categoryId));
    if (!ok) return false;
  }
  if (f.projectIds?.length && !f.projectIds.includes(t.projectId ?? '')) return false;
  if (f.tagIds?.length) {
    const has = (id: string) => t.tagIds.includes(id);
    if (f.tagMode === 'all' ? !f.tagIds.every(has) : !f.tagIds.some(has)) return false;
  }
  if (f.minMinor !== undefined && t.amountMinor < f.minMinor) return false;
  if (f.maxMinor !== undefined && t.amountMinor > f.maxMinor) return false;
  if (f.keyword && !t.note.toLowerCase().includes(f.keyword.toLowerCase())) return false;
  return true;
}

export { categoryChildren };

// ───────────── 心願清單（冷靜期） ─────────────

export type WishInput = Pick<Wish, 'name' | 'priceMinor' | 'currency' | 'coolDays' | 'note' | 'url' | 'categoryId'>;

export async function addWish(input: WishInput): Promise<string> {
  const today = todayKey();
  const row: Wish = { ...input, id: uid(), status: 'waiting', addedOn: today, decideAt: addDaysSafe(today, Math.max(1, input.coolDays)), createdAt: now(), updatedAt: now() };
  await db.wishes.add(row);
  return row.id;
}

/** 決定：買了（可連結帳目）或放棄（計入「冷靜期幫你省下」） */
export async function decideWish(id: string, decision: 'bought' | 'abandoned', transactionId?: string) {
  await db.wishes.update(id, { status: decision, decidedAt: now(), transactionId, updatedAt: now() });
}

/** 再冷靜一段時間 */
export async function extendWish(id: string, days: number) {
  const w = await db.wishes.get(id);
  if (!w) return;
  const base = w.decideAt > todayKey() ? w.decideAt : todayKey();
  await db.wishes.update(id, { decideAt: addDaysSafe(base, days), updatedAt: now() });
}

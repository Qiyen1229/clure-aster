/**
 * 操作助手（Agent）的「計畫 → 預覽」層，全部是純函式，不碰資料庫、不呼叫 AI。
 *
 * 流程：AI 只產出「工具＋參數」的步驟（伺服器已先做白名單驗證）→ 這裡再驗證一次、把名稱換成 id，
 * 並在「記憶體裡的工作副本」上依序模擬每一步（後面的步驟看得到前面步驟的結果），算出影響預覽
 * （受影響筆數、預算變化、帳戶餘額是否變動）。使用者確認後，才由 services/agent.ts 把同樣的操作真的寫入。
 *
 * 安全：工具白名單；每個工具的參數都重新驗證；一次最多改 MAX_AFFECTED 筆帳目；沒有任何工具會動帳戶餘額、刪帳目或轉帳。
 */
import type { Account, Budget, Category, RecurringRule, Transaction } from '@/db/types';
import { statAmount } from '@/domain/ledger';
import { currencyInfo, formatMoney } from '@/domain/money';
import { accountingMonth, addDays, type Range } from '@/domain/period';
import { occurrences } from '@/domain/recurrence';
import { loanStatus, simulatePrepayment } from '@/domain/loan';

export const MAX_AFFECTED = 500;
export const MAX_STEPS = 6;

export type ToolName = 'reclassify' | 'set_budget' | 'add_recurring' | 'prepayment_sim';
export interface RawStep { tool: string; args: Record<string, unknown> }

/** 計畫執行時要真的做的事（services/agent.ts 照這個寫入） */
export type Op =
  | { kind: 'recat'; ids: string[]; categoryId: string }
  | { kind: 'budget'; id?: string; input: Omit<Budget, 'id' | 'createdAt' | 'updatedAt'> }
  | { kind: 'recurring'; input: Omit<RecurringRule, 'id' | 'createdAt' | 'updatedAt' | 'nextDue' | 'doneCount' | 'pendingDates'> };

export interface StepPreview {
  tool: ToolName;
  /** 一句話標題，例如「把 23 筆帳目改歸到「通勤」」 */
  title: string;
  /** 影響明細（每行一件事） */
  lines: string[];
  /** 抽樣幾筆讓使用者核對（reclassify） */
  samples?: { date: string; note: string; amountMinor: number; from: string }[];
  warnings: string[];
  /** 有值代表這一步無法執行（原因） */
  blocked?: string;
  /** 只試算、不會寫入任何資料 */
  readonly?: boolean;
  /** 影響統計（彙總成 Diff 卡） */
  affectedTx?: number;
  budgetChanges?: number;
  rulesCreated?: number;
}

export interface ResolvedStep { preview: StepPreview; op: Op | null }

export interface AgentData {
  today: string;
  baseCurrency: string;
  monthStartDay: number;
  categories: Category[];
  accounts: Account[];
  budgets: Budget[];
  recurring: RecurringRule[];
  /** 候選帳目（近一年，未刪除）；預覽在這份的複本上模擬 */
  txs: Transaction[];
  defaultAccountId?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };
const dateOrNull = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

const usableCat = (c: Category) => !c.archived && !c.deletedAt && !c.system;

/** 名稱換成分類：名稱完全相同者優先取主分類；kind 給了就只看該類 */
export function findCategory(cats: Category[], name: string, kind?: 'expense' | 'income'): Category | undefined {
  const hit = cats.filter((c) => usableCat(c) && c.name === name && (!kind || c.kind === kind));
  return hit.find((c) => !c.parentId) ?? hit[0];
}
export const findAccount = (accs: Account[], name: string) => accs.find((a) => !a.archived && !a.deletedAt && a.name === name);

/** 預算是否涵蓋這個分類（總預算涵蓋全部；分類預算涵蓋自己與子分類） */
export function budgetCovers(budgetCategoryId: string, txCategoryId: string, catMap: Map<string, Category>): boolean {
  return !budgetCategoryId || budgetCategoryId === txCategoryId || catMap.get(txCategoryId)?.parentId === budgetCategoryId;
}

/** 這筆帳目會不會被預算計算（與 db/repo/plan.ts 的 budgetMatcher 一致） */
const countsForBudget = (t: Transaction) =>
  !t.deletedAt && (t.type === 'expense' || t.type === 'transfer_fee') && !t.excludeFromStats && !t.excludeFromBudget;

const inRange = (d: string, r: Range) => d >= r.start && d <= r.end;
const fmt = (minor: number, cur: string) => formatMoney(minor, cur, { decimals: 0 });
const minorOf = (amount: number, cur: string) => Math.round(amount * 10 ** currencyInfo(cur).exp);

/** 本月（記帳月）在某個分類範圍內已花多少 */
export function spentInMonth(txs: Transaction[], budgetCategoryId: string, catMap: Map<string, Category>, month: Range): number {
  let s = 0;
  for (const t of txs) if (countsForBudget(t) && inRange(t.date, month) && budgetCovers(budgetCategoryId, t.categoryId, catMap)) s += statAmount(t);
  return s;
}

// ───────────── 各工具 ─────────────

function reclassify(a: Record<string, unknown>, d: AgentData, work: Transaction[]): ResolvedStep {
  const wantKind = a.type === 'income' || a.type === 'expense' ? a.type : undefined; // 同名的收入／支出分類不要挑錯
  const to = findCategory(d.categories, str(a.to_category), wantKind) ?? (wantKind ? undefined : findCategory(d.categories, str(a.to_category)));
  const blocked = (why: string): ResolvedStep => ({ op: null, preview: { tool: 'reclassify', title: '批次改分類', lines: [], warnings: [], blocked: why } });
  if (!to) return blocked(`找不到分類「${str(a.to_category)}」`);
  const from = str(a.from_category) ? findCategory(d.categories, str(a.from_category)) : undefined;
  const acc = str(a.account) ? findAccount(d.accounts, str(a.account)) : undefined;
  const kws = (Array.isArray(a.keywords) ? a.keywords : []).map((k) => str(k).toLowerCase()).filter(Boolean).slice(0, 4);
  const ds = dateOrNull(a.date_start), de = dateOrNull(a.date_end);
  if (!kws.length && !from && !acc && !ds && !de) return blocked('沒有任何篩選條件（會變成整本帳都改分類），請描述得更具體');
  const catMap = new Map(d.categories.map((c) => [c.id, c]));

  const hits = work.filter((t) =>
    !t.deletedAt && !t.transferId && !t.stockTradeId && !t.dividendId && !t.categoryId.startsWith('sys-') &&
    t.type === to.kind && t.categoryId !== to.id &&
    (!ds || t.date >= ds) && (!de || t.date <= de) && (!acc || t.accountId === acc.id) &&
    (!from || t.categoryId === from.id || catMap.get(t.categoryId)?.parentId === from.id) &&
    (!kws.length || kws.some((k) => `${t.note} ${t.merchant ?? ''}`.toLowerCase().includes(k))));

  const label = [kws.length ? kws.join('、') : '', from ? `「${from.name}」` : '', acc ? `帳戶「${acc.name}」` : '',
    ds || de ? `${ds ?? ''}～${de ?? ''}` : ''].filter(Boolean).join('、');
  if (!hits.length) return blocked(`找不到符合條件的帳目（${label}）。候選範圍是最近一年；備註與商家名稱都有比對`);
  if (hits.length > MAX_AFFECTED) return blocked(`符合的帳目有 ${hits.length} 筆，超過一次最多 ${MAX_AFFECTED} 筆的上限，請縮小日期範圍`);

  const cur = d.baseCurrency;
  const total = hits.reduce((s, t) => s + (countsForBudget(t) ? statAmount(t) : 0), 0);
  const byFrom = new Map<string, number>();
  for (const t of hits) byFrom.set(t.categoryId, (byFrom.get(t.categoryId) ?? 0) + 1);
  const lines = [`符合條件：${label}`, `共 ${hits.length} 筆${total ? `，合計 ${fmt(total, cur)}` : ''}`,
    `原本的分類：${[...byFrom].map(([id, n]) => `${catMap.get(id)?.name ?? '其他'} ${n} 筆`).join('、')}`];

  // 預算影響：本期各預算涵蓋範圍的花費變化（只算改分類造成的位移）
  const month = accountingMonth(d.today, d.monthStartDay);
  let budgetLines = 0;
  for (const b of d.budgets) {
    if (!b.active || b.categoryId === '') continue;
    let delta = 0;
    for (const t of hits) {
      if (!countsForBudget(t) || !inRange(t.date, month)) continue;
      const was = budgetCovers(b.categoryId, t.categoryId, catMap), will = budgetCovers(b.categoryId, to.id, catMap);
      if (was && !will) delta -= statAmount(t);
      else if (!was && will) delta += statAmount(t);
    }
    if (!delta) continue;
    const before = spentInMonth(work, b.categoryId, catMap, month), after = before + delta;
    const pct = b.amountMinor > 0 ? Math.round((after / b.amountMinor) * 100) : 0;
    const alert = b.alertPercents[0] ?? 80;
    lines.push(`「${b.name}」預算：本月已花 ${fmt(before, cur)} → ${fmt(after, cur)}（額度 ${fmt(b.amountMinor, cur)}，${pct}%${pct > 100 ? '，會超支' : pct >= alert ? `，會超過 ${alert}% 提醒線` : ''}）`);
    budgetLines++;
  }
  if (!budgetLines) lines.push('預算：目前沒有任何預算會因此改變');
  lines.push('帳戶餘額：不受影響（只改分類）');

  const samples = [...hits].sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 5).map((t) => ({
    date: t.date, note: t.note || t.merchant || '（無備註）', amountMinor: statAmount(t), from: catMap.get(t.categoryId)?.name ?? '其他',
  }));
  // 模擬：後面的步驟看得到這一步的結果
  const ids = new Set(hits.map((t) => t.id));
  for (const t of work) if (ids.has(t.id)) t.categoryId = to.id;
  return {
    op: { kind: 'recat', ids: hits.map((t) => t.id), categoryId: to.id },
    preview: { tool: 'reclassify', title: `把 ${hits.length} 筆帳目改歸到「${to.name}」`, lines, samples, warnings: [], affectedTx: hits.length },
  };
}

function setBudget(a: Record<string, unknown>, d: AgentData, work: Transaction[], draftBudgets: Budget[]): ResolvedStep {
  const blocked = (why: string): ResolvedStep => ({ op: null, preview: { tool: 'set_budget', title: '設定預算', lines: [], warnings: [], blocked: why } });
  const amount = num(a.amount);
  if (!(amount > 0)) return blocked('預算金額必須大於 0');
  const catName = str(a.category);
  const cat = catName ? findCategory(d.categories, catName, 'expense') : undefined;
  if (catName && !cat) return blocked(`找不到支出分類「${catName}」`);
  const pctRaw = num(a.alert_percent);
  const pct = pctRaw >= 1 && pctRaw <= 100 ? Math.round(pctRaw) : 80;
  const cur = d.baseCurrency;
  const amountMinor = minorOf(amount, cur);
  const catMap = new Map(d.categories.map((c) => [c.id, c]));
  const categoryId = cat?.id ?? '';
  const existing = draftBudgets.find((b) => b.active && b.periodType === 'month' && !b.projectId && b.categoryId === categoryId);
  if (existing?.id.startsWith('draft-')) return blocked('同一份計畫裡已經設定過這個分類的預算了');
  const name = existing?.name ?? (cat ? `${cat.name}預算` : '每月總預算');
  const month = accountingMonth(d.today, d.monthStartDay);
  const spent = spentInMonth(work, categoryId, catMap, month);
  const used = Math.round((spent / amountMinor) * 100);
  const lines = [
    existing ? `把「${existing.name}」從 ${fmt(existing.amountMinor, cur)} 調成 ${fmt(amountMinor, cur)}／月` : `新增每月預算 ${fmt(amountMinor, cur)}（${cat ? `分類「${cat.name}」` : '全部支出'}）`,
    `花到 ${pct}% 時提醒你`,
    `本月已花 ${fmt(spent, cur)}（用掉 ${used}%）${used > 100 ? '，新額度一建立就已超支' : used >= pct ? `，一建立就會超過 ${pct}% 提醒線` : ''}`,
    '帳戶餘額：不受影響',
  ];
  const warnings: string[] = [];
  if (existing && existing.alertPercents[0] !== undefined && existing.alertPercents[0] !== pct) warnings.push(`提醒門檻會從 ${existing.alertPercents[0]}% 改成 ${pct}%`);
  const input: Omit<Budget, 'id' | 'createdAt' | 'updatedAt'> = existing
    ? { ...stripBase(existing), amountMinor, alertPercents: [pct] }
    : { name, periodType: 'month', startDate: `${d.today.slice(0, 8)}01`, amountMinor, currency: cur, categoryId, projectId: '', rollover: false, alertPercents: [pct], active: 1 };
  // 模擬：後面的步驟看得到這個預算
  if (existing) Object.assign(existing, { amountMinor, alertPercents: [pct] });
  else draftBudgets.push({ ...input, id: `draft-${draftBudgets.length}`, createdAt: 0, updatedAt: 0 });
  return {
    op: { kind: 'budget', id: existing?.id, input },
    preview: { tool: 'set_budget', title: existing ? `調整「${existing.name}」為 ${fmt(amountMinor, cur)}` : `新增「${name}」${fmt(amountMinor, cur)}／月`, lines, warnings, budgetChanges: 1 },
  };
}

function stripBase(b: Budget): Omit<Budget, 'id' | 'createdAt' | 'updatedAt'> {
  const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = b;  
  return rest;
}

function addRecurring(a: Record<string, unknown>, d: AgentData): ResolvedStep {
  const blocked = (why: string): ResolvedStep => ({ op: null, preview: { tool: 'add_recurring', title: '建立週期帳目', lines: [], warnings: [], blocked: why } });
  const name = str(a.name).slice(0, 30);
  const amount = num(a.amount);
  if (!name || !(amount > 0)) return blocked('名稱或金額不正確');
  const kind = a.kind === 'income' ? 'income' : 'expense';
  let cat = str(a.category) ? findCategory(d.categories, str(a.category), kind) : undefined;
  let catNote = '';
  if (!cat && !str(a.category)) {
    // 使用者沒說分類（例如「建立每月 12 號 Netflix 390 的訂閱」）：訂閱類優先找「訂閱」，否則放「其他」，並在預覽提醒
    cat = (a.kind === 'subscription' ? d.categories.find((c) => c.kind === kind && usableCat(c) && /訂閱/.test(c.name)) : undefined) ?? d.categories.find((c) => c.kind === kind && usableCat(c) && /^其他/.test(c.name));
    if (cat) catNote = `你沒有指定分類，先放在「${cat.name}」，之後可到週期帳目修改`;
  }
  if (!cat) return blocked(str(a.category) ? `找不到${kind === 'income' ? '收入' : '支出'}分類「${str(a.category)}」` : '請說明要記在哪個分類');
  const acc = (str(a.account) ? findAccount(d.accounts, str(a.account)) : undefined) ?? d.accounts.find((x) => x.id === d.defaultAccountId && !x.archived) ?? d.accounts.find((x) => !x.archived && !x.deletedAt && (x.type === 'bank' || x.type === 'cash'));
  if (!acc) return blocked('找不到可用的帳戶');
  const freq = a.freq === 'week' || a.freq === 'year' ? a.freq : 'month';
  const startGiven = dateOrNull(a.start_date);
  const dayRaw = num(a.day);
  const day = freq === 'month' && dayRaw >= 1 && dayRaw <= 31 ? Math.round(dayRaw) : null;
  // 第一次發生日：有給就用；每月幾號 → 今天（含）之後最近的那天；否則今天
  let start = startGiven ?? d.today;
  const rule = freq === 'month'
    ? { freq: 'month' as const, interval: 1, ...(day ? { byMonthDay: day, monthEndPolicy: 'clamp' as const } : {}) }
    : freq === 'week' ? { freq: 'week' as const, interval: 1 } : { freq: 'year' as const, interval: 1 };
  if (!startGiven && day) {
    const first = occurrences(rule, `${d.today.slice(0, 8)}01`, d.today, addDays(d.today, 400), 1)[0];
    if (first) start = first;
  }
  const next = occurrences(rule, start, d.today, addDays(d.today, 800), 3);
  const cur = acc.currency;
  const amountMinor = minorOf(amount, cur);
  const warnings: string[] = catNote ? [catNote] : [];
  const dup = d.recurring.find((r) => r.active && r.name.trim().toLowerCase() === name.toLowerCase());
  if (dup) warnings.push(`已經有一條同名的週期帳目「${dup.name}」，執行後會有兩條；要取代請先到「規劃 → 週期」刪掉舊的`);
  const freqText = freq === 'month' ? `每月${day ? ` ${day} 號` : ''}` : freq === 'week' ? '每週' : '每年';
  return {
    op: {
      kind: 'recurring',
      input: {
        kind: a.kind === 'subscription' ? 'subscription' : 'normal', name, mode: 'confirm', remindDaysBefore: 3, active: 1, startDate: start, rule,
        template: { type: kind, accountId: acc.id, categoryId: cat.id, amountMinor, currency: cur, note: name },
        ...(a.kind === 'subscription' ? { subscription: { service: name, priceHistory: [{ date: d.today, amountMinor }] } } : {}),
      },
    },
    preview: {
      tool: 'add_recurring', title: `建立週期帳目「${name}」${freqText} ${fmt(amountMinor, cur)}`,
      lines: [`分類「${cat.name}」，帳戶「${acc.name}」`, next.length ? `接下來的日期：${next.join('、')}` : '找不到下一次日期',
        '到期時提醒你確認入帳，不會自動記帳', '帳戶餘額：現在不受影響（到期確認後才會入帳）'],
      warnings, rulesCreated: 1,
    },
  };
}

function prepayment(a: Record<string, unknown>, d: AgentData): ResolvedStep {
  const base = (lines: string[], blocked?: string): ResolvedStep => ({ op: null, preview: { tool: 'prepayment_sim', title: '貸款提前還款試算', lines, warnings: [], readonly: true, blocked } });
  const acc = findAccount(d.accounts, str(a.account));
  if (!acc) return base([], `找不到帳戶「${str(a.account)}」`);
  if (!acc.loan) return base([], `「${acc.name}」沒有設定貸款資料（本金、年利率、期數、首期日），請先到帳戶補上`);
  const st = loanStatus(acc.loan, acc.balanceMinor, d.today);
  if (!st || st.actualBalanceMinor <= 0) return base([], `「${acc.name}」目前沒有欠款或貸款資料不完整`);
  const cur = acc.currency;
  const lump = minorOf(Math.max(0, num(a.lump_sum) || 0), cur), extra = minorOf(Math.max(0, num(a.extra_monthly) || 0), cur);
  if (!lump && !extra) return base([], '請說明要一次還多少，或每月多還多少');
  const sim = simulatePrepayment({ balanceMinor: st.actualBalanceMinor, aprDec: acc.loan.aprDec, paymentMinor: st.paymentMinor, lumpMinor: lump, extraMonthlyMinor: extra });
  if (!sim) return base([], '以目前的月付算不出還清時間（月付可能不夠付利息），請確認貸款資料');
  const yrs = (m: number) => `${Math.floor(m / 12) ? `${Math.floor(m / 12)} 年 ` : ''}${m % 12 ? `${m % 12} 個月` : ''}`.trim() || '0 個月';
  const lines = [`目前欠款 ${fmt(st.actualBalanceMinor, cur)}、年利率 ${acc.loan.aprDec}%、月付約 ${fmt(st.paymentMinor, cur)}`,
    `照現在的繳法：還要 ${yrs(sim.baseline.months)}，還要付利息約 ${fmt(sim.baseline.interestMinor, cur)}`];
  if (sim.shorten) lines.push(`① 一次還 ${fmt(lump, cur)}、月付不變 → 縮短 ${yrs(sim.shorten.savedMonths)}，省利息約 ${fmt(sim.shorten.savedInterestMinor, cur)}`);
  if (sim.lowerPayment) lines.push(`② 一次還 ${fmt(lump, cur)}、年限不變 → 月付降 ${fmt(sim.lowerPayment.paymentDropMinor, cur)}，省利息約 ${fmt(sim.lowerPayment.savedInterestMinor, cur)}`);
  if (sim.extra) lines.push(`每月多還 ${fmt(extra, cur)} → 縮短 ${yrs(sim.extra.savedMonths)}，省利息約 ${fmt(sim.extra.savedInterestMinor, cur)}`);
  lines.push('只是試算，不會動你的帳戶；實際以銀行試算為準（可能有提前還款違約金）');
  return { op: null, preview: { tool: 'prepayment_sim', title: `「${acc.name}」提前還款試算`, lines, warnings: [], readonly: true } };
}

// ───────────── 入口 ─────────────

/** 驗證並模擬整份計畫。回傳每一步的預覽與要執行的操作；不修改傳入的資料（在複本上模擬） */
export function resolvePlan(steps: RawStep[], data: AgentData): ResolvedStep[] {
  const work = data.txs.map((t) => ({ ...t }));
  const draftBudgets = data.budgets.map((b) => ({ ...b }));
  const out: ResolvedStep[] = [];
  for (const s of steps.slice(0, MAX_STEPS)) {
    const a = (s.args && typeof s.args === 'object' ? s.args : {}) as Record<string, unknown>;
    if (s.tool === 'reclassify') out.push(reclassify(a, data, work));
    else if (s.tool === 'set_budget') out.push(setBudget(a, data, work, draftBudgets));
    else if (s.tool === 'add_recurring') out.push(addRecurring(a, data));
    else if (s.tool === 'prepayment_sim') out.push(prepayment(a, data));
    else out.push({ op: null, preview: { tool: 'reclassify', title: '不支援的操作', lines: [], warnings: [], blocked: `不支援的操作「${String(s.tool).slice(0, 20)}」` } });
  }
  return out;
}

export interface PlanDiff { affectedTx: number; budgetChanges: number; rulesCreated: number; executable: number; blocked: number; readonly: number }

/** 影響彙總（執行預覽卡最上面那排） */
export function summarizePlan(steps: ResolvedStep[]): PlanDiff {
  const d: PlanDiff = { affectedTx: 0, budgetChanges: 0, rulesCreated: 0, executable: 0, blocked: 0, readonly: 0 };
  for (const s of steps) {
    if (s.preview.blocked) { d.blocked++; continue; }
    if (s.op) d.executable++; else if (s.preview.readonly) d.readonly++;
    d.affectedTx += s.preview.affectedTx ?? 0;
    d.budgetChanges += s.preview.budgetChanges ?? 0;
    d.rulesCreated += s.preview.rulesCreated ?? 0;
  }
  return d;
}

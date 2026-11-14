/**
 * 操作助手（Agent）的「計畫 → 預覽」層，全部是純函式，不碰資料庫、不呼叫 AI。
 *
 * 流程：AI 只產出「工具＋參數」的步驟（伺服器已先做白名單驗證）→ 這裡再驗證一次、把名稱換成 id，
 * 並在「記憶體裡的工作副本」上依序模擬每一步（後面的步驟看得到前面步驟的結果），算出影響預覽
 * （受影響筆數、預算變化、帳戶餘額是否變動）。使用者確認後，才由 services/agent.ts 把同樣的操作真的寫入。
 *
 * 安全：工具白名單；每個工具的參數都重新驗證；一次最多改 MAX_AFFECTED 筆帳目。
 * v4.1.12：新增 edit_transaction（改單筆帳目）與 delete_transaction（刪帳目）。刪除是軟刪除、整包可一鍵還原，一次最多 MAX_DELETE 筆；
 * 改金額／帳戶／日期必須明確指到「一筆」（符合多筆就擋下，請使用者說得更具體），不會把一堆帳目改成同一個金額。
 * v4.1.0 起動作圖譜擴大到「記帳、轉帳（含還款）、結清欠款、存入目標、買進股票」，預覽會在帳戶餘額的工作副本上依序模擬
 * （後面的步驟看得到前面步驟的結果），並以 show_view 步驟指定要在對話裡嵌入哪張檢視卡（財務自由、稅務、現金流、花費）。
 * 這幾個會動到帳戶的工具目前只支援主幣別帳戶（外幣需要匯率，請用記帳面板）。
 */
import type { Account, Budget, Category, CategoryRule, Dividend, Durable, Goal, Installment, Project, RecurringRule, Transaction, Transfer, Wish } from '@/db/types';
import type { InboxEntry } from '@/services/inbox';
import { statAmount } from '@/domain/ledger';
import { formatMoney } from '@/domain/money';
import { accountingMonth, addDays, type Range } from '@/domain/period';
import { occurrences } from '@/domain/recurrence';
import { loanStatus, simulatePrepayment } from '@/domain/loan';
import { buildSchedule, periodTotal } from '@/domain/installment';
import { twFee, twSellTax, twTaxRate, tradeValue, type TwFeeConfig } from '@/domain/invest/fees-tw';
import { toMinor } from '@/domain/money';
import Decimal from 'decimal.js';

export const MAX_AFFECTED = 500;
export const MAX_STEPS = 8;
/** 一次最多刪幾筆帳目 */
export const MAX_DELETE = 20;

export type ToolName = 'reclassify' | 'set_budget' | 'add_recurring' | 'prepayment_sim' | 'add_goal' | 'add_rule'
  | 'add_transaction' | 'transfer' | 'add_debt' | 'settle_debt' | 'goal_deposit' | 'buy_stock' | 'sell_stock' | 'show_view' | 'edit_transaction' | 'delete_transaction'
  | 'add_installment' | 'add_project' | 'set_travel_mode' | 'manage_recurring' | 'manage_inbox' | 'add_category' | 'add_dividend'
  | 'add_wish' | 'decide_wish' | 'manage_durable' | 'add_watch' | 'delete_transfer' | 'manage_debt' | 'edit_goal' | 'add_account';
/** 對話裡可以嵌入的檢視卡 */
export type ViewKind = 'fire' | 'tax' | 'cashflow' | 'spending';
export const VIEW_KINDS: ViewKind[] = ['fire', 'tax', 'cashflow', 'spending'];
export interface ViewSpec { kind: ViewKind; params: { retire_age?: number; annual_saving?: number; range?: 'this_month' | 'last_month' | 'this_year'; days?: number } }
export interface RawStep { tool: string; args: Record<string, unknown> }

/** 計畫執行時要真的做的事（services/agent.ts 照這個寫入） */
export type Op =
  | { kind: 'recat'; ids: string[]; categoryId: string }
  | { kind: 'budget'; id?: string; input: Omit<Budget, 'id' | 'createdAt' | 'updatedAt'> }
  | { kind: 'recurring'; input: Omit<RecurringRule, 'id' | 'createdAt' | 'updatedAt' | 'nextDue' | 'doneCount' | 'pendingDates'> }
  | { kind: 'tx_edit'; id: string; set: { amountMinor?: number; categoryId?: string; accountId?: string; note?: string; date?: string; projectId?: string; tagNames?: string[]; excludeFromBudget?: boolean; excludeFromStats?: boolean } }
  | { kind: 'tx_delete'; ids: string[] }
  | { kind: 'goal'; input: Omit<Goal, 'id' | 'createdAt' | 'updatedAt'> }
  | { kind: 'rule'; input: Omit<CategoryRule, 'id' | 'createdAt' | 'updatedAt' | 'hits'> }
  | { kind: 'tx'; input: { type: 'expense' | 'income'; accountId: string; categoryId: string; amountMinor: number; currency: string; date: string; note: string; projectId?: string; tagNames?: string[]; merchant?: string; excludeFromBudget?: boolean; excludeFromStats?: boolean; split?: { myShareMinor: number; personName: string } } }
  | { kind: 'transfer'; input: { fromAccountId: string; toAccountId: string; amountMinor: number; date: string; note: string } }
  | { kind: 'debt'; input: { direction: 'i_owe_them' | 'they_owe_me'; personName: string; amountMinor: number; currency: string; date: string; note: string; accountId?: string } }
  | { kind: 'settle'; debtId: string; accountId?: string }
  | { kind: 'goal_deposit'; goalId: string; amountMinor: number }
  | { kind: 'trade'; input: { side: 'buy' | 'sell'; stockId: string; accountId: string; date: string; sharesDec: string; priceDec: string; feeMinor: number; taxMinor: number; cashAccountId: string } }
  | { kind: 'category'; draftId: string; input: { name: string; kind: 'expense' | 'income'; parentId: string } }
  | { kind: 'account'; draftId: string; input: { name: string; type: 'bank' | 'cash' | 'credit' | 'epay'; currency: string; initialBalanceMinor: number } }
  | { kind: 'project'; draftId: string; input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> }
  | { kind: 'travel'; projectId: string | null }
  | { kind: 'installment'; input: Omit<Installment, 'id' | 'createdAt' | 'updatedAt' | 'schedule' | 'status'> }
  | { kind: 'recurring_manage'; ruleId: string; action: 'confirm' | 'skip' | 'pause' | 'resume' | 'delete' | 'edit'; date?: string; amountMinor?: number; day?: number; mode?: 'auto' | 'confirm' }
  | { kind: 'inbox'; action: 'book' | 'skip'; entries: InboxEntry[] }
  | { kind: 'dividend'; input: Omit<Dividend, 'id' | 'createdAt' | 'updatedAt' | 'transactionId' | 'stockTradeId'> & { syncToLedger: boolean } }
  | { kind: 'wish'; draftId: string; input: { name: string; priceMinor: number; currency: string; coolDays: number; categoryId?: string; note?: string; url?: string } }
  | { kind: 'wish_decide'; wishId: string; decision: 'bought' | 'abandoned' | 'extend' }
  | { kind: 'durable_add'; draftId: string; input: { name: string; costMinor: number; currency: string; purchaseDate: string; lifeYears?: number } }
  | { kind: 'durable_use'; durableId: string }
  | { kind: 'durable_sell'; durableId: string; endDate: string; saleMinor: number; income?: { accountId: string; categoryId: string } }
  | { kind: 'watch'; stockId: string; priceDec: string | null; op: '>=' | '<=' | null }
  | { kind: 'transfer_delete'; ids: string[] }
  | { kind: 'debt_manage'; action: 'delete' | 'unsettle'; debtIds: string[] }
  | { kind: 'goal_edit'; goalId: string; set: { targetMinor?: number; deadline?: string | null; linkedAccountIds?: string[]; status?: 'active' | 'archived' } };

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
  /** 新增的存錢目標、自動分類規則數 */
  goalsCreated?: number;
  autoRulesCreated?: number;
  /** 動到幾個帳戶的餘額、新增幾筆帳目／交易、結清幾筆欠款 */
  accountsTouched?: number;
  /** 動到餘額的帳戶 id：彙總時同一個帳戶不重複算（轉帳進出同一個帳戶的好幾步只算一個） */
  accountIds?: string[];
  txCreated?: number;
  debtsSettled?: number;
  debtsCreated?: number;
  /** 要在對話裡嵌入的檢視卡（只讀、不寫入） */
  view?: ViewSpec;
}

/** op＝這一步要做的一件事；ops＝一步要做好幾件事（例如結清同一個人的多筆欠款） */
export interface ResolvedStep { preview: StepPreview; op: Op | null; ops?: Op[] }
export const opsOf = (s: ResolvedStep): Op[] => (s.preview.blocked ? [] : s.ops ?? (s.op ? [s.op] : []));

export interface AgentData {
  today: string;
  baseCurrency: string;
  monthStartDay: number;
  categories: Category[];
  accounts: Account[];
  budgets: Budget[];
  recurring: RecurringRule[];
  goals?: Goal[];
  rules?: CategoryRule[];
  /** 候選帳目（近一年，未刪除）；預覽在這份的複本上模擬 */
  txs: Transaction[];
  defaultAccountId?: string;
  debts?: { id: string; personName: string; direction: 'they_owe_me' | 'i_owe_them'; amountMinor: number; currency: string; note: string; settled: number; loanTxId?: string; settleTransferId?: string }[];
  /** 已有的投資標的（含最新報價）；買進只支援這份清單裡的標的 */
  stocks?: { id: string; symbol: string; name: string; market: string; currency: string; assetType: 'stock' | 'etf' | 'bond_etf'; lotSize: number; priceDec?: string; taxRateDec?: string }[];
  /** 目前各標的的持股股數（標的 id → 股數字串）；賣出用它檢查夠不夠賣 */
  holdings?: Record<string, string>;
  feeConfig?: TwFeeConfig;
  defaultBrokerageId?: string;
  /** v4.1.39 全能助手：專案、願望、耐久財、轉帳、觀察清單、收件匣（預覽用，執行時以資料庫為準） */
  projects?: Project[];
  tags?: { id: string; name: string }[];
  wishes?: Wish[];
  durables?: Durable[];
  transfers?: Transfer[];
  watchlist?: { stockId: string; alerts: { priceDec: string; op: '>=' | '<='; enabled: boolean }[] }[];
  inbox?: InboxEntry[];
  travelProjectId?: string | null;
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
const minorOf = (amount: number, cur: string) => toMinor(amount, cur);

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

function addGoal(a: Record<string, unknown>, d: AgentData): ResolvedStep {
  const blocked = (why: string): ResolvedStep => ({ op: null, preview: { tool: 'add_goal', title: '建立存錢目標', lines: [], warnings: [], blocked: why } });
  const name = str(a.name).slice(0, 30);
  const amount = num(a.target_amount);
  if (!name || !(amount > 0)) return blocked('目標名稱或金額不正確');
  const cur = d.baseCurrency;
  const targetMinor = minorOf(amount, cur);
  const deadline = dateOrNull(a.deadline);
  const acc = str(a.account) ? findAccount(d.accounts, str(a.account)) : undefined;
  if (str(a.account) && !acc) return blocked(`找不到帳戶「${str(a.account)}」`);
  const warnings: string[] = [];
  const lines = [`目標金額 ${fmt(targetMinor, cur)}（已存 $0，之後可在「規劃 → 目標」連結帳戶或手動存入）`];
  if (acc) {
    lines[0] = `目標金額 ${fmt(targetMinor, cur)}，連結帳戶「${acc.name}」（目標進度＝帳戶餘額＋手動存入）`;
    if (acc.currency !== cur) warnings.push(`「${acc.name}」是外幣帳戶，目標進度會依匯率換算成 ${cur}`);
  }
  if (deadline && deadline > d.today) {
    const months = Math.max(1, Math.ceil((Date.parse(deadline) - Date.parse(d.today)) / 86_400_000 / 30.44));
    lines.push(`截止日 ${deadline}（約 ${months} 個月後），平均每月要存 ${fmt(Math.ceil(targetMinor / months), cur)}`);
  } else {
    lines.push('沒有設定截止日');
    if (deadline) warnings.push('你說的截止日已經過了，所以不設截止日');
  }
  const dup = (d.goals ?? []).find((g) => g.status === 'active' && g.name.trim() === name);
  if (dup) warnings.push(`已經有一個同名的進行中目標「${dup.name}」，執行後會有兩個`);
  return {
    op: { kind: 'goal', input: { start: d.today, name, icon: '🎯', color: '#0A84FF', targetMinor, currency: cur, deadline: deadline && deadline > d.today ? deadline : undefined, linkedAccountIds: acc ? [acc.id] : [], manualSavedMinor: 0, status: 'active' } },
    preview: { tool: 'add_goal', title: `建立存錢目標「${name}」${fmt(targetMinor, cur)}`, lines: [...lines, '帳戶餘額：不受影響'], warnings, goalsCreated: 1 },
  };
}

function addRule(a: Record<string, unknown>, d: AgentData, work: Transaction[]): ResolvedStep {
  const blocked = (why: string): ResolvedStep => ({ op: null, preview: { tool: 'add_rule', title: '建立自動分類規則', lines: [], warnings: [], blocked: why } });
  const pattern = str(a.pattern).slice(0, 20);
  if (pattern.length < 2) return blocked('關鍵字至少要兩個字');
  const cat = findCategory(d.categories, str(a.category));
  if (!cat) return blocked(`找不到分類「${str(a.category)}」`);
  const acc = str(a.account) ? findAccount(d.accounts, str(a.account)) : undefined;
  const key = pattern.toLowerCase();
  const warnings: string[] = [];
  const same = (d.rules ?? []).find((r) => r.enabled && r.match === 'contains' && r.keyword.trim().toLowerCase() === key);
  if (same) warnings.push(`已經有一條關鍵字相同的規則（歸到另一個分類時以優先順序較前的為準），執行後會有兩條`);
  // 目前已有幾筆帳目符合（模擬過前面步驟的改分類）：提醒「過去的帳要不要一起改」
  const hits = work.filter((t) => !t.deletedAt && t.type === cat.kind && `${t.note} ${t.merchant ?? ''}`.toLowerCase().includes(key));
  const already = hits.filter((t) => t.categoryId === cat.id).length;
  const lines = [
    `之後記帳時，備註或商家含「${pattern}」→ 自動歸入「${cat.name}」${acc ? `、記到「${acc.name}」` : ''}`,
    hits.length ? `目前近一年有 ${hits.length} 筆帳目含「${pattern}」（其中 ${already} 筆已在「${cat.name}」）；規則只管以後的帳，過去的要改請搭配「改分類」` : `目前近一年沒有帳目含「${pattern}」`,
    '帳戶餘額：不受影響',
  ];
  const priority = Math.max(0, ...(d.rules ?? []).map((r) => r.priority)) + 1;
  return {
    op: { kind: 'rule', input: { keyword: pattern, match: 'contains', kind: cat.kind, categoryId: cat.id, accountId: acc?.id, priority, enabled: true } },
    preview: { tool: 'add_rule', title: `新增自動分類規則：「${pattern}」→「${cat.name}」`, lines, warnings, autoRulesCreated: 1 },
  };
}


// ───────────── v4.1.0 擴充：記帳、轉帳、結清、存入目標、買進股票、檢視卡 ─────────────

/** 預覽時的工作副本：帳戶餘額、這份計畫裡新建的目標、已結清的欠款（後面的步驟看得到前面步驟的結果） */
interface Work {
  balances: Map<string, number>;
  draftGoals: Map<string, Extract<Op, { kind: 'goal' }>>;
  settled: Set<string>;
  /** 這份計畫買賣之後的持股股數（標的 id → 股數） */
  shares: Map<string, Decimal>;
  /** 這份計畫裡剛建立的專案（名稱 → op），set_travel_mode 可以直接切換過去 */
  draftProjects: Map<string, Extract<Op, { kind: 'project' }>>;
  /** 這份計畫裡已刪除的欠款 id */
  removedDebts: Set<string>;
  /** 這份計畫裡結清欠款時入帳的金額（欠款 id → 帳戶與增減），後面的取消結清／刪除要能退回 */
  settleEffects: Map<string, { accountId: string; delta: number }>;
  /** 草稿 id 流水號（分類／帳戶／專案／願望／耐久財共用，前綴不同） */
  draftSeq: number;
}

const blockedStep = (tool: ToolName, title: string, why: string): ResolvedStep => ({ op: null, preview: { tool, title, lines: [], warnings: [], blocked: why } });
const isDebtAccount = (a: Account) => a.isLiability || a.type === 'credit' || a.type === 'loan';
const usableAcc = (a: Account) => !a.archived && !a.deletedAt;
/** 這些會動帳戶的工具只做主幣別（外幣要匯率，請用記帳面板） */
const baseOnly = (a: Account, d: AgentData) => a.currency === d.baseCurrency;

function balanceLine(acc: Account, before: number, after: number, warnings: string[]): string {
  const debt = isDebtAccount(acc);
  if (!debt && after < 0 && before >= 0) warnings.push(`「${acc.name}」餘額會變成負數（${fmt(after, acc.currency)}）`);
  else if (!debt && after < 0) warnings.push(`「${acc.name}」餘額本來就不夠，執行後是 ${fmt(after, acc.currency)}`);
  return `「${acc.name}」${debt ? '欠款' : '餘額'}：${fmt(debt ? -before : before, acc.currency)} → ${fmt(debt ? -after : after, acc.currency)}`;
}

function addTransactionTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const title = '記一筆帳';
  const type = a.type === 'income' ? 'income' : 'expense';
  const acc = (str(a.account) ? findAccount(d.accounts, str(a.account)) : undefined) ?? d.accounts.find((x) => x.id === d.defaultAccountId && usableAcc(x));
  if (!acc) return blockedStep('add_transaction', title, str(a.account) ? `找不到帳戶「${str(a.account)}」` : '請說明記到哪個帳戶');
  if (!baseOnly(acc, d)) return blockedStep('add_transaction', title, `「${acc.name}」是外幣帳戶，需要匯率，請用記帳面板記這一筆`);
  const amount = num(a.amount);
  if (!(amount > 0)) return blockedStep('add_transaction', title, '金額必須大於 0');
  const cat = str(a.category) ? findCategory(d.categories, str(a.category), type) : d.categories.find((c) => c.kind === type && usableCat(c) && /^其他/.test(c.name));
  if (!cat) return blockedStep('add_transaction', title, str(a.category) ? `找不到${type === 'income' ? '收入' : '支出'}分類「${str(a.category)}」` : '請說明分類');
  const date = dateOrNull(a.date) ?? d.today;
  if (date > d.today) return blockedStep('add_transaction', title, '日期不能是未來（未來的固定收支請用週期帳目）');
  const named = str(a.project) ? (d.projects ?? []).find((p) => p.name === str(a.project) && p.status === 'active') : undefined;
  if (str(a.project) && !named) return blockedStep('add_transaction', title, `找不到專案「${str(a.project)}」（可以先說「建立專案 ${str(a.project)}」）`);
  // 旅遊模式：沒明寫專案就自動歸入目前的旅遊專案（和執行層一致）
  const project = named ?? (d.travelProjectId ? (d.projects ?? []).find((p) => p.id === d.travelProjectId && p.status === 'active') : undefined);
  const tagNames = [...new Set((Array.isArray(a.tags) ? a.tags : []).map((t) => str(t).slice(0, 20)).filter(Boolean))].slice(0, 6);
  const amountMinor = minorOf(amount, acc.currency);
  const note = str(a.note).slice(0, 60) || cat.name;
  // 分帳：我付我的份額，對方欠我剩下的（跟記帳面板的分帳一樣，會建立應收）
  const sp = a.split && typeof a.split === 'object' ? (a.split as Record<string, unknown>) : null;
  const myShare = sp ? num(sp.my_share) : NaN;
  const person = sp ? str(sp.person).slice(0, 30) : '';
  const split = sp && myShare > 0 && myShare < amount && person ? { myShareMinor: minorOf(myShare, acc.currency), personName: person } : undefined;
  const before = W.balances.get(acc.id) ?? acc.balanceMinor;
  const after = before + (type === 'income' ? amountMinor : -amountMinor);
  W.balances.set(acc.id, after);
  const warnings: string[] = [];
  const lines = [`${type === 'income' ? '收入' : '支出'}${fmt(amountMinor, acc.currency)}，分類「${cat.name}」，${date}`, balanceLine(acc, before, after, warnings)];
  if (project) lines.push(`歸入專案「${project.name}」`);
  if (tagNames.length) lines.push(`標籤：${tagNames.join('、')}${tagNames.some((t) => !(d.tags ?? []).some((x) => x.name === t)) ? '（不存在的名稱會自動建立）' : ''}`);
  if (split) lines.push(`分帳：我付 ${fmt(split.myShareMinor, acc.currency)}，${split.personName} 欠我 ${fmt(amountMinor - split.myShareMinor, acc.currency)}（會建立一筆應收，帳目只算我的份額）`);
  if (a.exclude_budget === true) lines.push('不計入預算');
  if (a.exclude_stats === true) lines.push('不計入收支統計');
  if (!str(a.category)) warnings.push(`你沒有指定分類，先放在「${cat.name}」`);
  if (sp && !split) warnings.push('分帳資訊不完整（我的份額要介於 0 和總金額之間、要有對象名字），這筆不分帳');
  return {
    op: { kind: 'tx', input: { type, accountId: acc.id, categoryId: cat.id, amountMinor, currency: acc.currency, date, note, projectId: project?.id, tagNames: tagNames.length ? tagNames : undefined, merchant: str(a.merchant).slice(0, 30) || undefined, excludeFromBudget: a.exclude_budget === true || undefined, excludeFromStats: a.exclude_stats === true || undefined, split } },
    preview: { tool: 'add_transaction', title: `${type === 'income' ? '收入' : '支出'} ${fmt(amountMinor, acc.currency)}（${note}）→「${acc.name}」`, lines, warnings, txCreated: 1, accountsTouched: 1, accountIds: [acc.id], debtsCreated: split ? 1 : 0 },
  };
}

function transferTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const title = '轉帳／還款';
  const from = findAccount(d.accounts, str(a.from_account)), to = findAccount(d.accounts, str(a.to_account));
  if (!from) return blockedStep('transfer', title, `找不到轉出帳戶「${str(a.from_account)}」`);
  if (!to) return blockedStep('transfer', title, `找不到轉入帳戶「${str(a.to_account)}」`);
  if (from.id === to.id) return blockedStep('transfer', title, '轉出與轉入帳戶不能相同');
  if (!baseOnly(from, d) || !baseOnly(to, d)) return blockedStep('transfer', title, '涉及外幣帳戶（需要匯率），請用記帳面板轉帳');
  const amount = num(a.amount);
  if (!(amount > 0)) return blockedStep('transfer', title, '金額必須大於 0');
  const date = dateOrNull(a.date) ?? d.today;
  if (date > d.today) return blockedStep('transfer', title, '日期不能是未來');
  const amountMinor = minorOf(amount, from.currency);
  const warnings: string[] = [];
  const bFrom = W.balances.get(from.id) ?? from.balanceMinor, bTo = W.balances.get(to.id) ?? to.balanceMinor;
  W.balances.set(from.id, bFrom - amountMinor);
  W.balances.set(to.id, bTo + amountMinor);
  const lines = [`從「${from.name}」轉 ${fmt(amountMinor, from.currency)} 到「${to.name}」，${date}`, balanceLine(from, bFrom, bFrom - amountMinor, warnings), balanceLine(to, bTo, bTo + amountMinor, warnings)];
  const repay = to.loan && bTo < 0 ? 'loan' : isDebtAccount(to) ? 'debt' : null;
  if (to.loan) {
    // 還貸款：沿用提前還款試算，讓使用者看到這筆還款能省多少利息
    const st = loanStatus(to.loan, to.balanceMinor, d.today);
    if (st && st.actualBalanceMinor > 0) {
      const sim = simulatePrepayment({ balanceMinor: st.actualBalanceMinor, aprDec: to.loan.aprDec, paymentMinor: st.paymentMinor, lumpMinor: amountMinor, extraMonthlyMinor: 0 });
      if (sim?.shorten) lines.push(`貸款提前還款：月付不變 → 縮短 ${Math.floor(sim.shorten.savedMonths / 12)} 年 ${sim.shorten.savedMonths % 12} 個月，省利息約 ${fmt(sim.shorten.savedInterestMinor, to.currency)}（實際以銀行為準，可能有違約金）`);
    }
  } else if (repay === 'debt') lines.push('這是繳卡費／還款，不算支出');
  return {
    op: { kind: 'transfer', input: { fromAccountId: from.id, toAccountId: to.id, amountMinor, date, note: str(a.note).slice(0, 60) } },
    preview: { tool: 'transfer', title: `轉帳 ${fmt(amountMinor, from.currency)}：「${from.name}」→「${to.name}」`, lines, warnings, txCreated: 1, accountsTouched: 2, accountIds: [from.id, to.id] },
  };
}

function addDebtTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const title = '記錄應收／應付';
  const direction = a.direction === 'they_owe_me' || a.direction === 'i_owe_them' ? a.direction : undefined;
  const personName = str(a.person).slice(0, 30);
  const amount = num(a.amount);
  const date = dateOrNull(a.date) ?? d.today;
  const note = str(a.note).slice(0, 80);
  if (!direction || !personName || !(amount > 0)) return blockedStep('add_debt', title, '請說明對象、借貸方向與正確金額');
  const acc = str(a.account) ? findAccount(d.accounts, str(a.account)) : undefined;
  if (str(a.account) && !acc) return blockedStep('add_debt', title, `找不到帳戶「${str(a.account)}」`);
  if (acc && !baseOnly(acc, d)) return blockedStep('add_debt', title, `「${acc.name}」是外幣帳戶，請到「記帳 → 應收／應付」記錄`);
  const amountMinor = minorOf(amount, d.baseCurrency);
  const warnings: string[] = [];
  const label = direction === 'they_owe_me' ? `${personName} 欠我` : `我欠 ${personName}`;
  const lines = [
    `類型：${direction === 'they_owe_me' ? '應收（對方欠我）' : '應付（我欠對方）'}`,
    `金額：${fmt(amountMinor, d.baseCurrency)}`,
    `日期：${date}`,
  ];
  if (note) lines.push(`備註：${note}`);
  if (acc) {
    const delta = direction === 'they_owe_me' ? -amountMinor : amountMinor;
    const before = W.balances.get(acc.id) ?? acc.balanceMinor;
    const after = before + delta;
    W.balances.set(acc.id, after);
    lines.push(balanceLine(acc, before, after, warnings));
  } else {
    lines.push('不變動帳戶餘額（只記錄應收／應付，結清時再入帳）');
  }
  return {
    op: { kind: 'debt', input: { direction, personName, amountMinor, currency: d.baseCurrency, date, note, accountId: acc?.id } },
    preview: {
      tool: 'add_debt',
      title: `記錄${direction === 'they_owe_me' ? '應收' : '應付'}：${label} ${fmt(amountMinor, d.baseCurrency)}${note ? `（${note}）` : ''}`,
      lines,
      warnings,
      debtsCreated: 1,
      accountsTouched: acc ? 1 : 0,
      accountIds: acc ? [acc.id] : [],
      txCreated: acc ? 1 : 0,
    },
  };
}

function settleDebtTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const title = '結清欠款';
  const person = str(a.person);
  if (!person) return blockedStep('settle_debt', title, '請說明是跟誰的欠款');
  const wantDir = a.direction === 'they_owe_me' || a.direction === 'i_owe_them' ? a.direction : undefined;
  const amount = num(a.amount);
  let hits = (d.debts ?? []).filter((x) => !x.settled && !W.settled.has(x.id) && x.personName === person && (!wantDir || x.direction === wantDir));
  if (amount > 0) hits = hits.filter((x) => x.amountMinor === minorOf(amount, x.currency));
  if (!hits.length) return blockedStep('settle_debt', title, `找不到跟「${person}」的未結清欠款${amount > 0 ? `（金額 ${amount}）` : ''}`);
  if (hits.length > 5) return blockedStep('settle_debt', title, `跟「${person}」有 ${hits.length} 筆欠款，請說明金額`);
  const acc = str(a.account) ? findAccount(d.accounts, str(a.account)) : undefined;
  if (str(a.account) && !acc) return blockedStep('settle_debt', title, `找不到帳戶「${str(a.account)}」`);
  if (acc && !baseOnly(acc, d)) return blockedStep('settle_debt', title, `「${acc.name}」是外幣帳戶，請到「專案 → 應收應付」結清`);
  if (hits.some((x) => x.currency !== d.baseCurrency) && acc) return blockedStep('settle_debt', title, '外幣欠款請到「專案 → 應收應付」結清');
  const warnings: string[] = [];
  const lines: string[] = [];
  let total = 0;
  for (const x of hits) {
    const theyPay = x.direction === 'they_owe_me';
    lines.push(`${theyPay ? `${x.personName} 還你` : `你還 ${x.personName}`} ${fmt(x.amountMinor, x.currency)}${x.note ? `（${x.note}）` : ''}`);
    total += theyPay ? x.amountMinor : -x.amountMinor;
    W.settled.add(x.id);
    if (acc) W.settleEffects.set(x.id, { accountId: acc.id, delta: theyPay ? x.amountMinor : -x.amountMinor });
  }
  if (acc) {
    const before = W.balances.get(acc.id) ?? acc.balanceMinor, after = before + total;
    W.balances.set(acc.id, after);
    lines.push(balanceLine(acc, before, after, warnings));
  } else lines.push('沒有指定帳戶：只標記為已結清，不動任何帳戶餘額');
  return {
    op: null,
    ops: hits.map((x) => ({ kind: 'settle', debtId: x.id, accountId: acc?.id }) as Op),
    preview: { tool: 'settle_debt', title: `結清 ${person} 的欠款（${hits.length} 筆，合計 ${fmt(Math.abs(total), d.baseCurrency)}）`, lines, warnings, debtsSettled: hits.length, accountsTouched: acc ? 1 : 0, accountIds: acc ? [acc.id] : [], txCreated: acc ? hits.length : 0 },
  };
}

function goalDepositTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const title = '存入目標';
  const name = str(a.goal);
  const amount = num(a.amount);
  if (!name || !(amount > 0)) return blockedStep('goal_deposit', title, '目標名稱或金額不正確');
  const cur = d.baseCurrency;
  const amountMinor = minorOf(amount, cur);
  const draft = W.draftGoals.get(name);
  if (draft) {
    // 這份計畫裡才剛建立的目標：把金額併進那一步，一起建立
    draft.input.manualSavedMinor += amountMinor;
    return { op: null, preview: { tool: 'goal_deposit', title: `存入「${name}」${fmt(amountMinor, cur)}`, lines: [`併入上一步建立的目標，一建立就有 ${fmt(draft.input.manualSavedMinor, cur)}`, '只記錄進度，不動帳戶餘額'], warnings: [], readonly: true } };
  }
  const goal = (d.goals ?? []).find((g) => g.status === 'active' && g.name === name);
  if (!goal) return blockedStep('goal_deposit', title, `找不到進行中的目標「${name}」`);
  const saved = goal.manualSavedMinor + amountMinor;
  return {
    op: { kind: 'goal_deposit', goalId: goal.id, amountMinor },
    preview: { tool: 'goal_deposit', title: `存入「${goal.name}」${fmt(amountMinor, goal.currency)}`, lines: [`手動存入：${fmt(goal.manualSavedMinor, goal.currency)} → ${fmt(saved, goal.currency)}（目標 ${fmt(goal.targetMinor, goal.currency)}，${Math.round((saved / Math.max(1, goal.targetMinor)) * 100)}%）`, '只記錄進度，不動帳戶餘額；要連動帳戶請到「規劃 → 目標」連結帳戶'], warnings: [] },
  };
}

/** 買進（扣款）與賣出（入帳）共用：賣出會檢查持股夠不夠（含這份計畫前面步驟的買賣），並算出手續費與證交稅、實拿金額 */
function tradeStockTool(side: 'buy' | 'sell', a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const buy = side === 'buy';
  const title = buy ? '買進股票' : '賣出股票';
  const tool: ToolName = buy ? 'buy_stock' : 'sell_stock';
  const symbol = str(a.symbol).toUpperCase();
  const stock = (d.stocks ?? []).find((s) => s.symbol.toUpperCase() === symbol);
  if (!stock) return blockedStep(tool, title, buy ? `投資頁裡還沒有「${symbol || '（未說明）'}」這檔標的，請先到「帳戶 → 投資」新增一次交易，之後就能用說的買進` : `投資頁裡沒有「${symbol || '（未說明）'}」這檔標的`);
  // 台股的 market 是 TWSE（上市）、TPEX（上櫃）、EMERGING（興櫃）；美股、港股需要匯率，請到投資頁記錄
  if (!['TWSE', 'TPEX', 'EMERGING'].includes(stock.market) || stock.currency !== d.baseCurrency) return blockedStep(tool, title, `「${stock.symbol}」不是台股／主幣別標的，請到投資頁記錄${buy ? '買進' : '賣出'}（需要匯率與手續費設定）`);
  const shares = num(a.shares);
  if (!(shares > 0)) return blockedStep(tool, title, '股數必須大於 0');
  // 賣出：持股要夠（以目前持股，加上這份計畫前面步驟的買賣）
  const held = W.shares.get(stock.id) ?? new Decimal(d.holdings?.[stock.id] ?? 0);
  if (!buy && new Decimal(shares).gt(held)) return blockedStep(tool, title, `「${stock.symbol}」目前只有 ${held.toString()} 股，不夠賣 ${shares} 股`);
  const priceGiven = num(a.price);
  const price = priceGiven > 0 ? new Decimal(priceGiven) : stock.priceDec ? new Decimal(stock.priceDec) : null;
  if (!price || price.lte(0)) return blockedStep(tool, title, `沒有「${stock.symbol}」的報價，請說明成交價（例如「${buy ? '買' : '賣'} 1000 股 0050，價格 180」）`);
  // 證券戶：投資設定的預設證券戶，沒有就用第一個證券帳戶（和投資頁的交易表單一樣）；扣款帳戶：你說的 → 證券戶的交割帳戶 → 證券戶本身
  const broker = d.accounts.find((x) => x.id === d.defaultBrokerageId && usableAcc(x)) ?? d.accounts.find((x) => usableAcc(x) && x.type === 'brokerage');
  const settle = broker?.brokerage?.settlementAccountId ? d.accounts.find((x) => x.id === broker.brokerage!.settlementAccountId && usableAcc(x)) : undefined;
  const acc = (str(a.account) ? findAccount(d.accounts, str(a.account)) : undefined) ?? settle ?? broker ?? d.accounts.find((x) => usableAcc(x) && x.type === 'bank');
  if (!acc) return blockedStep(tool, title, str(a.account) ? `找不到帳戶「${str(a.account)}」` : `請說明${buy ? '從' : '轉入'}哪個帳戶`);
  if (!baseOnly(acc, d)) return blockedStep(tool, title, `${buy ? '扣款' : '入帳'}帳戶是外幣帳戶，請到投資頁記錄${buy ? '買進' : '賣出'}`);
  const sharesD = new Decimal(shares);
  const gross = toMinor(tradeValue(price, sharesD), stock.currency);
  const fee = d.feeConfig ? twFee(price, sharesD, d.feeConfig, stock.lotSize) : 0;
  // 證交稅只有賣出才有：依標的類型（股票、ETF、債券 ETF）與你在投資設定的稅率
  const tax = !buy && d.feeConfig ? twSellTax(price, sharesD, twTaxRate(stock.assetType, d.feeConfig, stock.taxRateDec)) : 0;
  const net = buy ? gross + fee : gross - fee - tax; // 買：付出；賣：實拿
  const date = dateOrNull(a.date) ?? d.today;
  const before = W.balances.get(acc.id) ?? acc.balanceMinor, after = buy ? before - net : before + net;
  W.balances.set(acc.id, after);
  W.shares.set(stock.id, buy ? held.plus(sharesD) : held.minus(sharesD));
  const warnings: string[] = [];
  if (priceGiven > 0 && stock.priceDec && Math.abs(priceGiven - Number(stock.priceDec)) / Number(stock.priceDec) > 0.05) warnings.push(`你說的成交價 ${priceGiven} 和最近報價 ${stock.priceDec} 差超過 5%，請確認`);
  if (!(priceGiven > 0)) warnings.push(`沒有指定成交價，先以最近報價 ${stock.priceDec} 試算（實際成交價以券商為準，執行前可改說「價格 xxx」）`);
  const lotText = shares >= 1000 && shares % 1000 === 0 ? `${shares / 1000} 張` : `${shares} 股`;
  return {
    op: { kind: 'trade', input: { side, stockId: stock.id, accountId: broker?.id ?? acc.id, date, sharesDec: sharesD.toString(), priceDec: price.toString(), feeMinor: fee, taxMinor: tax, cashAccountId: acc.id } },
    preview: {
      tool, title: `${buy ? '買進' : '賣出'} ${stock.symbol} ${stock.name} ${lotText} @ ${price.toString()}`,
      lines: [
        buy ? `成交金額 ${fmt(gross, stock.currency)}、手續費約 ${fmt(fee, stock.currency)}，共 ${fmt(net, stock.currency)}（${date}）`
          : `成交金額 ${fmt(gross, stock.currency)}、手續費約 ${fmt(fee, stock.currency)}、證交稅約 ${fmt(tax, stock.currency)}，實拿 ${fmt(net, stock.currency)}（${date}）`,
        balanceLine(acc, before, after, warnings),
        buy ? '會同步記一筆「股票買進」帳目（不計入收支），手續費另記支出' : '會同步記一筆「股票賣出」帳目（不計入收支），手續費與證交稅另記支出；已實現損益依你的成本法在投資頁計算',
      ],
      warnings, txCreated: fee + tax > 0 ? 2 : 1, accountsTouched: 1, accountIds: [acc.id],
    },
  };
}

// ───────────── 改單筆／刪帳目（v4.1.12） ─────────────

/** 找出符合 match 條件的帳目：latest=true 取「最近記的那一筆」（依建立時間，所以補記舊日期的帳也算剛剛那筆） */
function matchTxs(m: Record<string, unknown>, d: AgentData, work: Transaction[]): { hits: Transaction[]; label: string; err?: string } {
  const catMap = new Map(d.categories.map((c) => [c.id, c]));
  const kws = (Array.isArray(m.keywords) ? m.keywords : []).map((k) => str(k).toLowerCase()).filter(Boolean).slice(0, 4);
  const cat = str(m.category) ? findCategory(d.categories, str(m.category)) : undefined;
  const acc = str(m.account) ? findAccount(d.accounts, str(m.account)) : undefined;
  const ds = dateOrNull(m.date_start), de = dateOrNull(m.date_end);
  const amount = num(m.amount);
  const latest = m.latest === true;
  const type = m.type === 'income' || m.type === 'expense' ? m.type : undefined;
  if (str(m.category) && !cat) return { hits: [], label: '', err: `找不到分類「${str(m.category)}」` };
  if (str(m.account) && !acc) return { hits: [], label: '', err: `找不到帳戶「${str(m.account)}」` };
  if (!kws.length && !cat && !acc && !ds && !de && !(amount > 0) && !latest) return { hits: [], label: '', err: '沒有任何篩選條件，請說明是哪一筆（例如「昨天的午餐」「剛剛那筆」）' };
  let hits = work.filter((t) =>
    !t.deletedAt && !t.transferId && !t.stockTradeId && !t.dividendId && !t.categoryId.startsWith('sys-') && (t.type === 'expense' || t.type === 'income') &&
    (!type || t.type === type) && (!ds || t.date >= ds) && (!de || t.date <= de) && (!acc || t.accountId === acc.id) &&
    (!cat || t.categoryId === cat.id || catMap.get(t.categoryId)?.parentId === cat.id) &&
    (!(amount > 0) || Math.abs(t.amountMinor - minorOf(amount, t.currency)) < 1) &&
    (!kws.length || kws.some((k) => `${t.note} ${t.merchant ?? ''} ${catMap.get(t.categoryId)?.name ?? ''}`.toLowerCase().includes(k))));
  if (latest && hits.length) hits = [hits.reduce((a, b) => (b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.ts > a.ts) ? b : a))];
  const label = [latest ? '最近記的一筆' : '', kws.join('、'), cat ? `「${cat.name}」` : '', acc ? `帳戶「${acc.name}」` : '', ds || de ? `${ds ?? ''}～${de ?? ''}` : '', amount > 0 ? `金額 ${amount}` : ''].filter(Boolean).join('、');
  return { hits, label };
}

const sampleOf = (t: Transaction, catMap: Map<string, Category>) => ({ date: t.date, note: t.note || t.merchant || '（無備註）', amountMinor: statAmount(t), from: catMap.get(t.categoryId)?.name ?? '其他' });

function editTxTool(a: Record<string, unknown>, d: AgentData, work: Transaction[]): ResolvedStep {
  const blocked = (why: string): ResolvedStep => ({ op: null, preview: { tool: 'edit_transaction', title: '修改帳目', lines: [], warnings: [], blocked: why } });
  const m = (a.match && typeof a.match === 'object' ? a.match : {}) as Record<string, unknown>;
  const s = (a.set && typeof a.set === 'object' ? a.set : {}) as Record<string, unknown>;
  const { hits, label, err } = matchTxs(m, d, work);
  if (err) return blocked(err);
  if (!hits.length) return blocked(`找不到符合條件的帳目（${label}）。候選範圍是最近一年`);
  const catMap = new Map(d.categories.map((c) => [c.id, c]));
  const t = hits[0];
  const set: Extract<Op, { kind: 'tx_edit' }>['set'] = {};
  const lines: string[] = [];
  const cur = d.baseCurrency;
  const newAmount = num(s.amount);
  if (s.amount !== undefined && s.amount !== null) {
    if (!(newAmount > 0)) return blocked('金額必須大於 0');
    set.amountMinor = minorOf(newAmount, t.currency);
  }
  if (str(s.category)) {
    const c = findCategory(d.categories, str(s.category), t.type === 'income' ? 'income' : 'expense');
    if (!c) return blocked(`找不到${t.type === 'income' ? '收入' : '支出'}分類「${str(s.category)}」`);
    set.categoryId = c.id;
  }
  if (str(s.account)) {
    const ac = findAccount(d.accounts, str(s.account));
    if (!ac) return blocked(`找不到帳戶「${str(s.account)}」`);
    set.accountId = ac.id;
  }
  if (typeof s.note === 'string') set.note = s.note.trim().slice(0, 60);
  if (s.date !== undefined && s.date !== null) {
    const nd = dateOrNull(s.date);
    if (!nd) return blocked('日期格式不正確');
    set.date = nd;
  }
  if (str(s.project)) {
    const p = (d.projects ?? []).find((x) => x.name === str(s.project) && x.status === 'active');
    if (!p) return blocked(`找不到專案「${str(s.project)}」`);
    set.projectId = p.id;
  }
  if (Array.isArray(s.tags)) set.tagNames = [...new Set(s.tags.map((t) => str(t).slice(0, 20)).filter(Boolean))].slice(0, 6);
  if (typeof s.exclude_budget === 'boolean') set.excludeFromBudget = s.exclude_budget;
  if (typeof s.exclude_stats === 'boolean') set.excludeFromStats = s.exclude_stats;
  if (!Object.keys(set).length) return blocked('沒有要修改的內容');
  const needsOne = set.amountMinor !== undefined || set.accountId !== undefined || set.date !== undefined;
  if (hits.length > 1 && needsOne) return blocked(`符合條件的帳目有 ${hits.length} 筆，改金額、帳戶或日期必須明確指到一筆（例如說出日期或金額，或說「剛剛那筆」）`);
  if (hits.length > MAX_AFFECTED) return blocked(`符合的帳目有 ${hits.length} 筆，超過上限 ${MAX_AFFECTED} 筆`);
  if (needsOne) {
    if (t.split || t.installmentId) return blocked('這筆是分帳或分期帳目，金額、帳戶、日期請到帳目詳情修改');
    const acc = d.accounts.find((x) => x.id === (set.accountId ?? t.accountId));
    if ((set.amountMinor !== undefined || set.accountId !== undefined) && acc && acc.currency !== t.currency) return blocked('外幣帳目的金額、帳戶請用記帳面板修改（需要匯率）');
  }
  // 預覽（逐筆只示範第一筆；多筆時只有分類或備註會改）
  const pieces: string[] = [];
  if (set.amountMinor !== undefined) pieces.push(`金額 ${fmt(t.amountMinor, t.currency)} → ${fmt(set.amountMinor, t.currency)}`);
  if (set.categoryId) pieces.push(`分類「${catMap.get(t.categoryId)?.name ?? '其他'}」→「${catMap.get(set.categoryId)?.name}」`);
  if (set.accountId) pieces.push(`帳戶「${d.accounts.find((x) => x.id === t.accountId)?.name ?? ''}」→「${d.accounts.find((x) => x.id === set.accountId)?.name}」`);
  if (set.note !== undefined) pieces.push(`備註「${t.note}」→「${set.note}」`);
  if (set.date) pieces.push(`日期 ${t.date} → ${set.date}`);
  if (set.projectId) pieces.push(`專案 →「${(d.projects ?? []).find((x) => x.id === set.projectId)?.name}」`);
  if (set.tagNames !== undefined) pieces.push(set.tagNames.length ? `標籤 → ${set.tagNames.join('、')}` : '標籤 → 清空');
  if (set.excludeFromBudget !== undefined) pieces.push(set.excludeFromBudget ? '不計入預算' : '計入預算');
  if (set.excludeFromStats !== undefined) pieces.push(set.excludeFromStats ? '不計入收支統計' : '計入收支統計');
  lines.push(`符合條件：${label}`, `共 ${hits.length} 筆`, ...pieces);
  const delta = (set.amountMinor !== undefined ? set.amountMinor - t.amountMinor : 0) * (t.type === 'income' ? 1 : -1);
  lines.push(set.amountMinor !== undefined || set.accountId ? `帳戶餘額：${delta >= 0 ? '增加' : '減少'} ${fmt(Math.abs(delta), cur)}（${set.accountId ? '兩個帳戶都會跟著調整' : '依新金額重算'}）` : '帳戶餘額：不受影響');
  const ids = new Set(hits.map((x) => x.id));
  for (const w of work) {
    if (!ids.has(w.id)) continue;
    if (set.amountMinor !== undefined) { w.amountMinor = set.amountMinor; w.accountAmountMinor = set.amountMinor; w.baseAmountMinor = w.currency === cur ? set.amountMinor : w.baseAmountMinor; }
    if (set.categoryId) w.categoryId = set.categoryId;
    if (set.accountId) w.accountId = set.accountId;
    if (set.note !== undefined) w.note = set.note;
    if (set.date) w.date = set.date;
    if (set.projectId) w.projectId = set.projectId;
    if (set.excludeFromBudget !== undefined) w.excludeFromBudget = set.excludeFromBudget;
    if (set.excludeFromStats !== undefined) w.excludeFromStats = set.excludeFromStats;
  }
  const ops: Op[] = hits.map((x) => ({ kind: 'tx_edit', id: x.id, set }));
  return {
    op: null, ops,
    preview: { tool: 'edit_transaction', title: hits.length === 1 ? `修改帳目：${t.note || t.merchant || catMap.get(t.categoryId)?.name || ''} ${fmt(t.amountMinor, t.currency)}` : `修改 ${hits.length} 筆帳目`, lines,
      samples: hits.slice(0, 5).map((x) => sampleOf(x, catMap)), warnings: hits.length > 1 ? [`會一次改 ${hits.length} 筆`] : [], affectedTx: hits.length },
  };
}

function deleteTxTool(a: Record<string, unknown>, d: AgentData, work: Transaction[]): ResolvedStep {
  const blocked = (why: string): ResolvedStep => ({ op: null, preview: { tool: 'delete_transaction', title: '刪除帳目', lines: [], warnings: [], blocked: why } });
  const m = (a.match && typeof a.match === 'object' ? a.match : {}) as Record<string, unknown>;
  const { hits, label, err } = matchTxs(m, d, work);
  if (err) return blocked(err);
  if (!hits.length) return blocked(`找不到符合條件的帳目（${label}）。候選範圍是最近一年`);
  if (hits.length > MAX_DELETE) return blocked(`符合的帳目有 ${hits.length} 筆，一次最多刪 ${MAX_DELETE} 筆，請縮小範圍（例如指定日期）`);
  const catMap = new Map(d.categories.map((c) => [c.id, c]));
  const cur = d.baseCurrency;
  const total = hits.reduce((s, t) => s + statAmount(t), 0);
  const lines = [`符合條件：${label}`, `共 ${hits.length} 筆，合計 ${fmt(total, cur)}`,
    ...hits.slice(0, 8).map((t) => `${t.date}　${t.note || t.merchant || catMap.get(t.categoryId)?.name || ''}　${t.type === 'income' ? '＋' : '－'}${fmt(t.amountMinor, t.currency)}`),
    ...(hits.length > 8 ? [`…還有 ${hits.length - 8} 筆`] : []),
    '帳戶餘額：會把這些帳目的影響退回去', '這是軟刪除：執行後可以按「還原」全部救回來'];
  const ids = new Set(hits.map((x) => x.id));
  for (const w of work) if (ids.has(w.id)) w.deletedAt = Date.now();
  return {
    op: { kind: 'tx_delete', ids: hits.map((x) => x.id) },
    preview: { tool: 'delete_transaction', title: hits.length === 1 ? `刪除帳目：${hits[0].note || hits[0].merchant || catMap.get(hits[0].categoryId)?.name || ''} ${fmt(hits[0].amountMinor, hits[0].currency)}` : `刪除 ${hits.length} 筆帳目`,
      lines, samples: hits.slice(0, 5).map((x) => sampleOf(x, catMap)), warnings: hits.length > 1 ? [`會一次刪 ${hits.length} 筆，請確認清單`] : [], affectedTx: hits.length },
  };
}

function showViewTool(a: Record<string, unknown>): ResolvedStep {
  const kind = VIEW_KINDS.find((k) => k === a.view);
  if (!kind) return blockedStep('show_view', '顯示檢視', `不支援的檢視「${str(a.view).slice(0, 20)}」`);
  const params: ViewSpec['params'] = {};
  const ra = num(a.retire_age), sv = num(a.annual_saving), days = num(a.days);
  if (kind === 'fire') {
    if (ra >= 30 && ra <= 80) params.retire_age = Math.round(ra);
    if (sv >= 0 && sv < 1e9 && a.annual_saving !== undefined && a.annual_saving !== null) params.annual_saving = Math.round(sv);
  }
  if (kind === 'cashflow' && days >= 30 && days <= 180) params.days = Math.round(days);
  if (kind === 'spending') params.range = a.range === 'last_month' || a.range === 'this_year' ? a.range : 'this_month';
  const names: Record<ViewKind, string> = { fire: '財務自由模擬', tax: '稅務規劃', cashflow: '現金流預測', spending: '花費分析' };
  return {
    op: null,
    preview: { tool: 'show_view', title: `顯示「${names[kind]}」`, lines: ['只是檢視，不會寫入任何資料；執行上面的步驟後會依新資料重算'], warnings: [], readonly: true, view: { kind, params } },
  };
}

// ───────────── v4.1.39 全能助手：分期、專案、旅遊模式、週期管理、收件匣、分類、股利、願望、耐久財、觀察、刪轉帳、欠款管理、改目標、新帳戶 ─────────────

const ACC_TYPE_LABEL: Record<string, string> = { bank: '銀行', cash: '現金', credit: '信用卡', epay: '電子支付' };
const cur3 = (v: unknown): string | null => { const s = str(v).toUpperCase(); return /^[A-Z]{3}$/.test(s) ? s : null; };
const findProject = (d: AgentData, name: string) => (d.projects ?? []).find((p) => p.name === name && p.status === 'active');

function addCategoryTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'add_category';
  const name = str(a.name).slice(0, 20);
  const kind = a.kind === 'income' ? 'income' : 'expense';
  if (!name) return blockedStep(tool, '新增分類', '請說明分類名稱');
  if (findCategory(d.categories, name, kind)) return blockedStep(tool, '新增分類', `已經有${kind === 'income' ? '收入' : '支出'}分類「${name}」了`);
  const parent = str(a.parent) ? findCategory(d.categories, str(a.parent), kind) : undefined;
  if (str(a.parent) && !parent) return blockedStep(tool, '新增分類', `找不到主分類「${str(a.parent)}」`);
  if (parent?.parentId) return blockedStep(tool, '新增分類', '子分類底下不能再建子分類');
  const id = `draft-cat-${W.draftSeq++}`;
  d.categories.push({ id, kind, parentId: parent?.id ?? '', name, icon: '🏷️', color: '#8E8E93', sort: 999, archived: 0, createdAt: 0, updatedAt: 0 });
  return {
    op: { kind: 'category', draftId: id, input: { name, kind, parentId: parent?.id ?? '' } },
    preview: { tool, title: `新增${kind === 'income' ? '收入' : '支出'}分類「${name}」`, lines: [parent ? `放在「${parent.name}」底下` : '主分類', '之後記帳就可以選這個分類', '帳戶餘額：不受影響'], warnings: [] },
  };
}

function addAccountTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'add_account';
  const name = str(a.name).slice(0, 30);
  const type = a.type === 'cash' || a.type === 'credit' || a.type === 'epay' ? a.type : a.type === 'bank' ? 'bank' : null;
  if (!name || !type) return blockedStep(tool, '新增帳戶', '請說明帳戶名稱與類型（銀行／現金／信用卡／電子支付）');
  if (findAccount(d.accounts, name)) return blockedStep(tool, '新增帳戶', `已經有帳戶「${name}」了`);
  const currency = cur3(a.currency) ?? d.baseCurrency;
  const initial = Math.max(0, num(a.initial_balance) || 0);
  const initialMinor = minorOf(initial, currency);
  const id = `draft-acc-${W.draftSeq++}`;
  d.accounts.push({ id, name, icon: type === 'credit' ? '💳' : type === 'cash' ? '💵' : '🏦', color: '#0A84FF', type, currency, initialBalanceMinor: initialMinor, balanceMinor: initialMinor, includeInNetWorth: true, isLiability: type === 'credit', sort: 999, archived: 0, createdAt: 0, updatedAt: 0 });
  W.balances.set(id, initialMinor);
  const warnings: string[] = [];
  if (type === 'credit') warnings.push('信用卡的結帳日、額度、年費請之後到帳戶頁補上');
  if (currency !== d.baseCurrency) warnings.push(`這是外幣帳戶（${currency}），之後記外幣帳需要匯率`);
  return {
    op: { kind: 'account', draftId: id, input: { name, type, currency, initialBalanceMinor: initialMinor } },
    preview: { tool, title: `新增${ACC_TYPE_LABEL[type]}帳戶「${name}」`, lines: [`幣別 ${currency}，期初餘額 ${fmt(initialMinor, currency)}`, '後面的步驟可以直接用這個帳戶記帳／轉帳'], warnings },
  };
}

function addProjectTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'add_project';
  const name = str(a.name).slice(0, 30);
  if (!name) return blockedStep(tool, '建立專案', '請說明專案名稱');
  const start = dateOrNull(a.start_date) ?? d.today;
  const end = dateOrNull(a.end_date);
  if (end && end < start) return blockedStep(tool, '建立專案', '結束日不能早於開始日');
  const currency = cur3(a.currency) ?? d.baseCurrency;
  const budget = num(a.budget);
  const isTravel = a.is_travel === true;
  const warnings: string[] = [];
  if (findProject(d, name)) warnings.push(`已經有一個同名的進行中專案「${name}」，執行後會有兩個`);
  const id = `draft-proj-${W.draftSeq++}`;
  const input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> = { name, icon: isTravel ? '✈️' : '📁', color: '#0A84FF', start, end: end ?? undefined, currency, budgetMinor: budget > 0 ? minorOf(budget, currency) : undefined, status: 'active', isTravel: isTravel || undefined, note: str(a.note).slice(0, 60) || undefined };
  d.projects = [...(d.projects ?? []), { ...input, id, createdAt: 0, updatedAt: 0 }];
  const op: Extract<Op, { kind: 'project' }> = { kind: 'project', draftId: id, input };
  W.draftProjects.set(name, op);
  const lines = [`期間 ${start}${end ? `～${end}` : '（未設結束日）'}，幣別 ${currency}`];
  if (budget > 0) lines.push(`專案預算 ${fmt(minorOf(budget, currency), currency)}`);
  if (isTravel) lines.push('旅遊專案：建立後可以說「切換到旅遊模式」，首頁與記帳會改成旅遊版面');
  lines.push('帳戶餘額：不受影響');
  return { op, preview: { tool, title: `建立${isTravel ? '旅遊' : ''}專案「${name}」`, lines, warnings } };
}

function setTravelModeTool(a: Record<string, unknown>, d: AgentData): ResolvedStep {
  const tool: ToolName = 'set_travel_mode';
  const name = str(a.project);
  const current = d.travelProjectId ? (d.projects ?? []).find((p) => p.id === d.travelProjectId) : undefined;
  if (!name) {
    d.travelProjectId = null;
    return {
      op: { kind: 'travel', projectId: null },
      preview: { tool, title: '切回一般模式', lines: [current ? `離開「${current.name}」旅遊模式，首頁與記帳恢復一般版面` : '目前已經是一般模式', '已歸入專案的帳目不受影響'], warnings: [] },
    };
  }
  const proj = findProject(d, name);
  if (!proj) return blockedStep(tool, '切換旅遊模式', `找不到進行中的專案「${name}」（可以先說「建立專案 ${name}」）`);
  if (!proj.isTravel) return blockedStep(tool, '切換旅遊模式', `「${name}」不是旅遊專案，請先到專案頁把它改成旅遊專案`);
  const warnings: string[] = [];
  if (current && current.id !== proj.id) warnings.push(`目前已在「${current.name}」旅遊模式，會改切到「${name}」`);
  d.travelProjectId = proj.id;
  return {
    op: { kind: 'travel', projectId: proj.id },
    preview: { tool, title: `切換到旅遊模式：「${name}」`, lines: ['首頁改成旅行版面，記帳未指定專案時自動歸入這個專案', `預設幣別 ${proj.currency}`, '隨時可以說「切回一般模式」'], warnings },
  };
}

function manageRecurringTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'manage_recurring';
  const title = '管理週期帳目';
  const name = str(a.name);
  const same = d.recurring.filter((r) => r.name.trim() === name);
  if (!same.length) return blockedStep(tool, title, `找不到週期帳目「${name}」`);
  if (same.length > 1) return blockedStep(tool, title, `有 ${same.length} 條同名的「${name}」，請先到「規劃 → 週期」改名`);
  const r = same[0];
  const action = a.action;
  const cur = r.template.currency ?? d.baseCurrency;
  const acc = d.accounts.find((x) => x.id === r.template.accountId);
  const pending = [...r.pendingDates].sort();
  const pickDate = (): string | null => {
    const given = dateOrNull(a.date);
    if (given) return pending.includes(given) ? given : null;
    return pending[0] ?? null;
  };
  if (action === 'confirm' || action === 'skip') {
    const date = pickDate();
    if (!date) return blockedStep(tool, title, dateOrNull(a.date) ? `「${name}」沒有 ${dateOrNull(a.date)} 這期待確認` : `「${name}」目前沒有待確認的期數`);
    const amtRaw = num(a.amount);
    const amountMinor = action === 'confirm' && amtRaw > 0 ? minorOf(amtRaw, cur) : undefined;
    if (action === 'skip') {
      r.pendingDates = r.pendingDates.filter((x) => x !== date);
      return {
        op: { kind: 'recurring_manage', ruleId: r.id, action: 'skip', date },
        preview: { tool, title: `略過「${name}」${date} 這期`, lines: ['這期不入帳，從待確認移除', '帳戶餘額：不受影響'], warnings: ['略過的那期不會自動補回；執行後可按「還原」救回'] },
      };
    }
    const amt = amountMinor ?? r.template.amountMinor ?? 0;
    const warnings: string[] = [];
    const lines = [`${date} 這期入帳 ${fmt(amt, cur)}${amountMinor !== undefined ? `（原 ${fmt(r.template.amountMinor ?? 0, cur)}）` : ''}`];
    if (acc) {
      const before = W.balances.get(acc.id) ?? acc.balanceMinor;
      const after = before + (r.template.type === 'income' ? amt : -amt);
      W.balances.set(acc.id, after);
      lines.push(balanceLine(acc, before, after, warnings));
    }
    if (r.kind === 'subscription' && amountMinor !== undefined && amountMinor !== r.template.amountMinor) {
      lines.push(`訂閱價格更新為 ${fmt(amountMinor, cur)}，之後每期以新價格入帳（會記錄價格歷史）`);
      r.template = { ...r.template, amountMinor };
    }
    r.pendingDates = r.pendingDates.filter((x) => x !== date);
    return {
      op: { kind: 'recurring_manage', ruleId: r.id, action: 'confirm', date, amountMinor },
      preview: { tool, title: `確認入帳「${name}」${date}`, lines, warnings, txCreated: 1, accountsTouched: acc ? 1 : 0, accountIds: acc ? [acc.id] : [] },
    };
  }
  if (action === 'pause' || action === 'resume') {
    const pause = action === 'pause';
    if (pause && !r.active) return blockedStep(tool, title, `「${name}」已經暫停了`);
    if (!pause && r.active) return blockedStep(tool, title, `「${name}」已經是啟用狀態`);
    r.active = pause ? 0 : 1;
    return {
      op: { kind: 'recurring_manage', ruleId: r.id, action },
      preview: { tool, title: `${pause ? '暫停' : '恢復'}「${name}」`, lines: [pause ? '暫停後到期不會入帳、不會提醒，隨時可以恢復' : '恢復後到期會照常入帳／提醒', '帳戶餘額：現在不受影響'], warnings: [] },
    };
  }
  if (action === 'delete') {
    return {
      op: { kind: 'recurring_manage', ruleId: r.id, action: 'delete' },
      preview: { tool, title: `刪除週期帳目「${name}」`, lines: ['之後不會再產生新的期數', '已經入帳的帳目會保留', '執行後可按「還原」把規則整條救回來'], warnings: [] },
    };
  }
  if (action === 'edit') {
    const amtRaw = num(a.amount), dayRaw = num(a.day);
    const amountMinor = amtRaw > 0 ? minorOf(amtRaw, cur) : undefined;
    const day = dayRaw >= 1 && dayRaw <= 31 ? Math.round(dayRaw) : undefined;
    const mode = a.mode === 'auto' || a.mode === 'confirm' ? a.mode : undefined;
    if (amountMinor === undefined && day === undefined && !mode) return blockedStep(tool, title, '請說明要改什麼（金額、每月幾號、自動入帳或待確認）');
    if (day !== undefined && r.rule.freq !== 'month') return blockedStep(tool, title, '這條不是每月週期，不能改「幾號」');
    const lines: string[] = [];
    if (amountMinor !== undefined) lines.push(`金額 ${fmt(r.template.amountMinor ?? 0, cur)} → ${fmt(amountMinor, cur)}`);
    if (day !== undefined) lines.push(`每月 ${r.rule.freq === 'month' ? r.rule.byMonthDay ?? '（未設）' : ''} 號 → ${day} 號`);
    if (mode) lines.push(mode === 'auto' ? '改成自動入帳：到期直接記帳，不再等確認' : '改成待確認：到期先通知，確認後才入帳');
    lines.push('帳戶餘額：現在不受影響（下一期開始生效）');
    return {
      op: { kind: 'recurring_manage', ruleId: r.id, action: 'edit', amountMinor, day, mode },
      preview: { tool, title: `修改週期帳目「${name}」`, lines, warnings: [] },
    };
  }
  return blockedStep(tool, title, '不支援的操作');
}

function manageInboxTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'manage_inbox';
  const title = '處理收件匣';
  const all = d.inbox ?? [];
  if (!all.length) return blockedStep(tool, title, '收件匣目前沒有待確認項目');
  const action = a.action === 'skip' ? 'skip' : 'book';
  const kw = str(a.keyword).toLowerCase();
  const hits = kw ? all.filter((e) => `${e.item.merchant} ${e.item.text} ${e.drafts.map((x) => x.note).join(' ')}`.toLowerCase().includes(kw)) : all;
  if (!hits.length) return blockedStep(tool, title, `收件匣裡找不到符合「${str(a.keyword)}」的項目`);
  if (action === 'skip') {
    const lines = hits.slice(0, 8).map((e) => {
      const label = e.item.merchant || e.drafts[0]?.note || e.item.text.slice(0, 20);
      const dr = e.drafts[0];
      return dr ? `${label}　${fmt(toMinor(dr.amount, dr.currency ?? d.baseCurrency), dr.currency ?? d.baseCurrency)}` : label;
    });
    if (hits.length > 8) lines.push(`…還有 ${hits.length - 8} 筆`);
    lines.push('帳戶餘額：不受影響');
    return {
      op: { kind: 'inbox', action: 'skip', entries: hits },
      preview: { tool, title: `略過收件匣 ${hits.length} 筆`, lines, warnings: ['略過會直接從伺服器刪除這些項目，無法還原'] },
    };
  }
  const bookable = hits.filter((e) => e.drafts.length && e.dup?.level !== 'strong');
  const dupN = hits.filter((e) => e.dup?.level === 'strong').length;
  const noDraft = hits.filter((e) => !e.drafts.length).length;
  if (!bookable.length) return blockedStep(tool, title, '這些項目都看不懂金額或疑似重複，請到收件匣手動處理');
  const warnings: string[] = ['記帳後項目會從伺服器移除；「還原」會刪掉記下的帳目，但項目不會回到收件匣'];
  if (dupN) warnings.push(`${dupN} 筆疑似重複，會留在收件匣等你確認`);
  if (noDraft) warnings.push(`${noDraft} 筆看不懂金額，需要到收件匣手動記`);
  const lines: string[] = [];
  const touched = new Set<string>();
  for (const e of bookable) {
    for (const dr of e.drafts) {
      const acc = d.accounts.find((x) => x.id === dr.accountId);
      if (!acc) continue;
      const amt = minorOf(dr.amount, acc.currency);
      const before = W.balances.get(acc.id) ?? acc.balanceMinor;
      if (dr.kind === 'transfer') {
        const to = d.accounts.find((x) => x.id === dr.toAccountId);
        if (!to) continue;
        W.balances.set(acc.id, before - amt);
        const bTo = W.balances.get(to.id) ?? to.balanceMinor;
        W.balances.set(to.id, bTo + amt);
        lines.push(`${dr.date}　${dr.note}　${fmt(amt, acc.currency)}　「${acc.name}」→「${to.name}」`);
        touched.add(acc.id); touched.add(to.id);
      } else {
        const after = before + (dr.kind === 'income' ? amt : -amt);
        W.balances.set(acc.id, after);
        lines.push(`${dr.date}　${dr.note}　${dr.kind === 'income' ? '＋' : '－'}${fmt(amt, acc.currency)}　→「${acc.name}」`);
        touched.add(acc.id);
      }
    }
  }
  for (const id of touched) {
    const acc = d.accounts.find((x) => x.id === id);
    if (acc) lines.push(balanceLine(acc, acc.balanceMinor, W.balances.get(id) ?? acc.balanceMinor, warnings));
  }
  return {
    op: { kind: 'inbox', action: 'book', entries: bookable },
    preview: { tool, title: `把收件匣 ${bookable.length} 筆記帳`, lines, warnings, txCreated: bookable.reduce((s, e) => s + e.drafts.length, 0), accountsTouched: touched.size, accountIds: [...touched] },
  };
}

function addInstallmentTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'add_installment';
  const title = '建立分期付款';
  const name = str(a.name).slice(0, 30);
  const acc = findAccount(d.accounts, str(a.account));
  const amount = num(a.amount);
  const periods = Math.round(num(a.periods));
  if (!name || !(amount > 0)) return blockedStep(tool, title, '請說明名稱與總金額');
  if (!acc) return blockedStep(tool, title, str(a.account) ? `找不到帳戶「${str(a.account)}」` : '請說明扣款帳戶');
  if (!baseOnly(acc, d)) return blockedStep(tool, title, '外幣分期請到「規劃 → 分期」建立（需要匯率）');
  if (!(periods >= 2 && periods <= 60)) return blockedStep(tool, title, '期數要介於 2 到 60 期');
  const apr = Math.max(0, num(a.apr) || 0);
  if (apr > 50) return blockedStep(tool, title, '年利率不合理（超過 50%），請確認');
  const fee = Math.max(0, num(a.fee) || 0);
  const firstDate = dateOrNull(a.first_date) ?? d.today;
  const cat = str(a.category) ? findCategory(d.categories, str(a.category), 'expense') : d.categories.find((c) => c.kind === 'expense' && usableCat(c) && /^其他/.test(c.name));
  if (!cat) return blockedStep(tool, title, str(a.category) ? `找不到支出分類「${str(a.category)}」` : '請說明分類');
  const principalMinor = minorOf(amount, acc.currency);
  const schedule = buildSchedule({ principalMinor, periods, aprDec: String(apr), feeMinor: minorOf(fee, acc.currency), feeMode: 'first', firstDate });
  const dueNow = schedule.filter((s) => s.date <= d.today);
  const warnings: string[] = [];
  const lines = [`總本金 ${fmt(principalMinor, acc.currency)}，${periods} 期，年利率 ${apr}%${fee > 0 ? `，手續費 ${fmt(minorOf(fee, acc.currency), acc.currency)}（第一期收取）` : ''}`,
    `第一期 ${firstDate}，每期約 ${fmt(periodTotal(schedule[0]), acc.currency)}${apr > 0 ? '（本息平均攤還）' : ''}`];
  if (dueNow.length) {
    const amt = dueNow.reduce((s, x) => s + periodTotal(x), 0);
    const before = W.balances.get(acc.id) ?? acc.balanceMinor;
    W.balances.set(acc.id, before - amt);
    lines.push(`已到期的 ${dueNow.length} 期會立刻入帳（共 ${fmt(amt, acc.currency)}）`, balanceLine(acc, before, before - amt, warnings));
  } else lines.push('帳戶餘額：現在不受影響（第一期到期才入帳）');
  lines.push('之後每期到期自動記帳，可在「規劃 → 分期」查看攤還表');
  return {
    op: { kind: 'installment', input: { name, accountId: acc.id, categoryId: cat.id, principalMinor, currency: acc.currency, periods, aprDec: String(apr), feeMinor: minorOf(fee, acc.currency), feeMode: 'first', firstDate } },
    preview: { tool, title: `建立分期「${name}」${periods} 期`, lines, warnings, txCreated: dueNow.length, accountsTouched: dueNow.length ? 1 : 0, accountIds: dueNow.length ? [acc.id] : [] },
  };
}

function addDividendTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'add_dividend';
  const title = '記錄股利';
  const symbol = str(a.symbol).toUpperCase();
  const stock = (d.stocks ?? []).find((s) => s.symbol.toUpperCase() === symbol);
  if (!stock) return blockedStep(tool, title, `投資頁裡沒有「${symbol || '（未說明）'}」這檔標的`);
  if (stock.currency !== d.baseCurrency) return blockedStep(tool, title, '外幣標的的股利請到投資頁記錄（需要匯率）');
  const per = num(a.per_share);
  if (!(per > 0)) return blockedStep(tool, title, '請說明每股股利（或每股配股數）');
  const held = new Decimal(W.shares.get(stock.id) ?? d.holdings?.[stock.id] ?? 0);
  if (held.lte(0)) return blockedStep(tool, title, `目前沒有「${stock.symbol}」的持股，請先記錄買進`);
  const kind = a.kind === 'stock' ? 'stock' : 'cash';
  const payDate = dateOrNull(a.pay_date) ?? d.today;
  const exDate = dateOrNull(a.ex_date) ?? payDate;
  const status = payDate > d.today ? 'announced' : 'paid';
  const broker = d.accounts.find((x) => x.id === d.defaultBrokerageId && usableAcc(x)) ?? d.accounts.find((x) => usableAcc(x) && x.type === 'brokerage');
  const settle = broker?.brokerage?.settlementAccountId ? d.accounts.find((x) => x.id === broker.brokerage!.settlementAccountId && usableAcc(x)) : undefined;
  const acc = (str(a.account) ? findAccount(d.accounts, str(a.account)) : undefined) ?? settle ?? broker ?? d.accounts.find((x) => usableAcc(x) && x.type === 'bank');
  if (!acc) return blockedStep(tool, title, str(a.account) ? `找不到帳戶「${str(a.account)}」` : '請說明現金入帳帳戶');
  if (acc.currency !== stock.currency) return blockedStep(tool, title, `入帳帳戶幣別和標的不同（需要匯率），請到投資頁記錄`);
  const cur = stock.currency;
  const gross = kind === 'cash' ? toMinor(new Decimal(per).mul(held), cur) : 0;
  const withholding = cur === 'USD' ? Math.floor(gross * 0.3) : 0;
  // 與 repo/invest 的 nhiSupplement 相同：台股單次 ≥ 2 萬扣 2.11% 二代健保
  const nhi = cur === 'TWD' && gross >= 2_000_000 ? toMinor(new Decimal(gross).div(100).mul('0.0211').floor(), 'TWD') : 0;
  const fee = cur === 'TWD' ? minorOf(10, cur) : 0;
  const net = Math.max(0, gross - withholding - nhi - fee);
  const warnings: string[] = [];
  const lines: string[] = [];
  const perD = new Decimal(per);
  if (kind === 'cash') {
    lines.push(`每股 ${per} × ${held.toString()} 股 = ${fmt(gross, cur)}`);
    lines.push(`預扣 ${fmt(withholding, cur)}、二代健保 ${fmt(nhi, cur)}、匯費 ${fmt(fee, cur)} → 實拿 ${fmt(net, cur)}`);
    if (status === 'paid' && net > 0) {
      const before = W.balances.get(acc.id) ?? acc.balanceMinor;
      W.balances.set(acc.id, before + net);
      lines.push(balanceLine(acc, before, before + net, warnings));
    }
  } else {
    const extra = perD.mul(held).floor();
    lines.push(`每股配 ${per} 股 × ${held.toString()} 股 = 配 ${extra.toString()} 股（不足 1 股不記）`);
    if (status === 'paid') W.shares.set(stock.id, (W.shares.get(stock.id) ?? held).plus(extra));
    lines.push('帳戶餘額：不受影響（配股只增加持股）');
  }
  lines.push(`除息日 ${exDate}、發放日 ${payDate}${status === 'announced' ? '（還沒發放，先記為已宣告，不入帳）' : ''}`);
  if (status === 'paid') warnings.push('預扣與健保是依常見規則估算，實際以券商為準；執行後可到投資頁修改');
  return {
    op: { kind: 'dividend', input: { stockId: stock.id, accountId: acc.id, kind, exDate, payDate, perShareDec: perD.toString(), sharesHeldDec: held.toString(), grossMinor: gross, withholdingTaxMinor: withholding, nhiSupplementMinor: nhi, feeMinor: fee, netMinor: kind === 'cash' ? net : 0, currency: cur, status, syncToLedger: true } },
    preview: { tool, title: `${stock.symbol} ${kind === 'cash' ? '現金股利' : '股票股利'} ${kind === 'cash' ? fmt(net, cur) : `配 ${perD.mul(held).floor()} 股`}`, lines, warnings, txCreated: kind === 'cash' && status === 'paid' && net > 0 ? 1 : 0, accountsTouched: kind === 'cash' && status === 'paid' && net > 0 ? 1 : 0, accountIds: kind === 'cash' && status === 'paid' && net > 0 ? [acc.id] : [] },
  };
}

function addWishTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'add_wish';
  const name = str(a.name).slice(0, 30);
  const price = num(a.price);
  if (!name || !(price > 0)) return blockedStep(tool, '加入願望清單', '請說明想買什麼、多少錢');
  const coolRaw = Math.round(num(a.cool_days));
  const coolDays = coolRaw >= 1 && coolRaw <= 365 ? coolRaw : 30;
  const cat = str(a.category) ? findCategory(d.categories, str(a.category), 'expense') : undefined;
  if (str(a.category) && !cat) return blockedStep(tool, '加入願望清單', `找不到支出分類「${str(a.category)}」`);
  const warnings: string[] = [];
  if ((d.wishes ?? []).some((w) => w.status === 'waiting' && w.name === name)) warnings.push(`願望清單裡已經有「${name}」了，執行後會有兩筆`);
  const url = str(a.url);
  const priceMinor = minorOf(price, d.baseCurrency);
  // 放進工作副本：同一份計畫後面的 decide_wish 用名稱就找得到（執行時再把草稿 id 換成真的 id）
  const draftId = `draft-wish-${W.draftSeq++}`;
  (d.wishes ??= []).push({ id: draftId, name, priceMinor, currency: d.baseCurrency, coolDays, addedOn: d.today, decideAt: addDays(d.today, coolDays), status: 'waiting', createdAt: 0, updatedAt: 0 });
  return {
    op: { kind: 'wish', draftId, input: { name, priceMinor, currency: d.baseCurrency, coolDays, categoryId: cat?.id, note: str(a.note).slice(0, 60) || undefined, url: /^https?:\/\//.test(url) ? url.slice(0, 200) : undefined } },
    preview: { tool, title: `願望清單＋「${name}」${fmt(priceMinor, d.baseCurrency)}`, lines: [`先冷靜 ${coolDays} 天，${addDays(d.today, coolDays)} 再決定買或不買`, '帳戶餘額：不受影響（買了再記帳）'], warnings },
  };
}

function decideWishTool(a: Record<string, unknown>, d: AgentData): ResolvedStep {
  const tool: ToolName = 'decide_wish';
  const name = str(a.name);
  const wish = (d.wishes ?? []).find((w) => w.status === 'waiting' && w.name === name);
  if (!wish) return blockedStep(tool, '決定願望', `願望清單裡找不到等待中的「${name}」`);
  const decision = a.decision === 'bought' || a.decision === 'abandoned' || a.decision === 'extend' ? a.decision : null;
  if (!decision) return blockedStep(tool, '決定願望', '請說明是買了、不買了，還是再冷靜一下');
  wish.status = decision === 'extend' ? 'waiting' : decision;
  const text = decision === 'bought' ? '標記為已買（不會自動記帳；有花錢請再說「記一筆…」）'
    : decision === 'abandoned' ? `標記為不買了，${fmt(wish.priceMinor, wish.currency)} 計入「冷靜期幫你省下」`
      : `冷靜期延長 7 天，${addDays(wish.decideAt > d.today ? wish.decideAt : d.today, 7)} 再決定`;
  return { op: { kind: 'wish_decide', wishId: wish.id, decision }, preview: { tool, title: `願望「${name}」：${decision === 'bought' ? '買了' : decision === 'abandoned' ? '不買了' : '再冷靜 7 天'}`, lines: [text, '帳戶餘額：不受影響'], warnings: [] } };
}

function manageDurableTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'manage_durable';
  const title = '管理耐久財';
  const action = a.action;
  const name = str(a.name).slice(0, 30);
  if (!name) return blockedStep(tool, title, '請說明物品名稱');
  if (action === 'add') {
    const cost = num(a.cost);
    if (!(cost > 0)) return blockedStep(tool, title, '請說明購入價');
    const purchaseDate = dateOrNull(a.date) ?? d.today;
    if (purchaseDate > d.today) return blockedStep(tool, title, '購入日不能是未來');
    const lifeRaw = Math.round(num(a.life_years));
    const lifeYears = lifeRaw >= 1 && lifeRaw <= 100 ? lifeRaw : undefined;
    if ((d.durables ?? []).some((x) => x.status === 'active' && x.name === name)) return blockedStep(tool, title, `已經在追蹤「${name}」了`);
    const costMinor = minorOf(cost, d.baseCurrency);
    // 放進工作副本：同一份計畫後面的 use／sell 用名稱就找得到（執行時再把草稿 id 換成真的 id）
    const draftId = `draft-dur-${W.draftSeq++}`;
    (d.durables ??= []).push({ id: draftId, name, icon: '📦', purchaseDate, costMinor, currency: d.baseCurrency, lifeYears, status: 'active', uses: 0, createdAt: 0, updatedAt: 0 });
    return {
      op: { kind: 'durable_add', draftId, input: { name, costMinor, currency: d.baseCurrency, purchaseDate, lifeYears } },
      preview: { tool, title: `開始追蹤「${name}」`, lines: [`購入價 ${fmt(costMinor, d.baseCurrency)}，${purchaseDate}${lifeYears ? `，預計用 ${lifeYears} 年` : ''}`, '追蹤每日持有成本；不會自動記帳（購入的支出請用「記一筆」）', '帳戶餘額：不受影響'], warnings: [] },
    };
  }
  const item = (d.durables ?? []).find((x) => x.status === 'active' && x.name === name);
  if (!item) return blockedStep(tool, title, `找不到追蹤中的「${name}」`);
  if (action === 'use') {
    const uses = (item.uses ?? 0) + 1;
    item.uses = uses;
    return { op: { kind: 'durable_use', durableId: item.id }, preview: { tool, title: `「${name}」用了一次`, lines: [`使用次數 ${uses - 1} → ${uses}，每次使用成本會跟著更新`, '帳戶餘額：不受影響'], warnings: [] } };
  }
  if (action === 'sell') {
    const price = num(a.price);
    if (!(price >= 0) || Number.isNaN(price)) return blockedStep(tool, title, '請說明賣出金額（淘汰填 0）');
    const endDate = dateOrNull(a.date) ?? d.today;
    if (endDate < item.purchaseDate) return blockedStep(tool, title, '處置日不能早於購入日');
    const saleMinor = minorOf(price, item.currency);
    const acc = str(a.account) ? findAccount(d.accounts, str(a.account)) : undefined;
    if (str(a.account) && !acc) return blockedStep(tool, title, `找不到帳戶「${str(a.account)}」`);
    if (acc && acc.currency !== item.currency) return blockedStep(tool, title, '入帳帳戶幣別和物品不同（需要匯率），請到耐久財頁處理');
    const warnings: string[] = [];
    const lines = [saleMinor > 0 ? `賣出 ${fmt(saleMinor, item.currency)}，結束追蹤` : '淘汰／送人，結束追蹤', `處置日 ${endDate}`];
    if (saleMinor > 0 && acc) {
      const before = W.balances.get(acc.id) ?? acc.balanceMinor;
      W.balances.set(acc.id, before + saleMinor);
      lines.push(`同時記一筆二手收入到「${acc.name}」`, balanceLine(acc, before, before + saleMinor, warnings));
    } else if (saleMinor > 0) lines.push('沒有指定帳戶：只記錄殘值，不入帳');
    item.status = saleMinor > 0 ? 'sold' : 'retired';
    return {
      op: { kind: 'durable_sell', durableId: item.id, endDate, saleMinor, income: saleMinor > 0 && acc ? { accountId: acc.id, categoryId: 'inc-other_inc' } : undefined },
      preview: { tool, title: `${saleMinor > 0 ? '賣掉' : '淘汰'}「${name}」`, lines, warnings, txCreated: saleMinor > 0 && acc ? 1 : 0, accountsTouched: saleMinor > 0 && acc ? 1 : 0, accountIds: saleMinor > 0 && acc ? [acc.id] : [] },
    };
  }
  return blockedStep(tool, title, '不支援的操作');
}

function addWatchTool(a: Record<string, unknown>, d: AgentData): ResolvedStep {
  const tool: ToolName = 'add_watch';
  const symbol = str(a.symbol).toUpperCase();
  const stock = (d.stocks ?? []).find((s) => s.symbol.toUpperCase() === symbol);
  if (!stock) return blockedStep(tool, '加入觀察清單', `投資頁裡沒有「${symbol || '（未說明）'}」這檔標的，請先新增一次交易`);
  const price = num(a.price);
  const op = a.op === '>=' || a.op === '<=' ? a.op : price > 0 ? '>=' : null;
  const existing = (d.watchlist ?? []).find((w) => w.stockId === stock.id);
  const lines = [existing ? `「${stock.symbol}」已經在觀察清單裡` : `把「${stock.symbol} ${stock.name}」加入觀察清單`];
  if (price > 0 && op) lines.push(`到價提醒：${op === '>=' ? '漲到' : '跌到'} ${price} 時通知你`);
  else lines.push('不設到價提醒');
  lines.push('帳戶餘額：不受影響');
  return {
    op: { kind: 'watch', stockId: stock.id, priceDec: price > 0 ? String(price) : null, op: price > 0 ? op : null },
    preview: { tool, title: `觀察「${stock.symbol}」${price > 0 && op ? `（${op === '>=' ? '≥' : '≤'} ${price} 提醒）` : ''}`, lines, warnings: [] },
  };
}

function deleteTransferTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'delete_transfer';
  const title = '刪除轉帳';
  const m = (a.match && typeof a.match === 'object' ? a.match : {}) as Record<string, unknown>;
  const from = str(m.from_account) ? findAccount(d.accounts, str(m.from_account)) : undefined;
  const to = str(m.to_account) ? findAccount(d.accounts, str(m.to_account)) : undefined;
  if (str(m.from_account) && !from) return blockedStep(tool, title, `找不到轉出帳戶「${str(m.from_account)}」`);
  if (str(m.to_account) && !to) return blockedStep(tool, title, `找不到轉入帳戶「${str(m.to_account)}」`);
  const ds = dateOrNull(m.date_start), de = dateOrNull(m.date_end);
  const amount = num(m.amount);
  const kws = (Array.isArray(m.keywords) ? m.keywords : []).map((k) => str(k).toLowerCase()).filter(Boolean).slice(0, 4);
  if (!from && !to && !ds && !de && !(amount > 0) && !kws.length) return blockedStep(tool, title, '沒有任何條件，請說明是哪筆轉帳（例如「昨天轉到玉山的 5000」）');
  const hits = (d.transfers ?? []).filter((t) => !t.deletedAt &&
    (!from || t.fromAccountId === from.id) && (!to || t.toAccountId === to.id) &&
    (!ds || t.date >= ds) && (!de || t.date <= de) &&
    (!(amount > 0) || Math.abs(t.fromAmountMinor - minorOf(amount, d.baseCurrency)) < 1) &&
    (!kws.length || kws.some((k) => t.note.toLowerCase().includes(k))));
  if (!hits.length) return blockedStep(tool, title, '找不到符合條件的轉帳（候選範圍是最近一年）');
  if (hits.length > MAX_DELETE) return blockedStep(tool, title, `符合的轉帳有 ${hits.length} 筆，一次最多刪 ${MAX_DELETE} 筆，請縮小範圍`);
  const accName = (id: string) => d.accounts.find((x) => x.id === id)?.name ?? '';
  const warnings: string[] = [];
  const lines = hits.slice(0, 8).map((t) => `${t.date}　「${accName(t.fromAccountId)}」→「${accName(t.toAccountId)}」　${fmt(t.fromAmountMinor, d.baseCurrency)}${t.note ? `（${t.note}）` : ''}`);
  if (hits.length > 8) lines.push(`…還有 ${hits.length - 8} 筆`);
  const touched = new Set<string>();
  for (const t of hits) {
    const bFrom = W.balances.get(t.fromAccountId) ?? d.accounts.find((x) => x.id === t.fromAccountId)?.balanceMinor ?? 0;
    const bTo = W.balances.get(t.toAccountId) ?? d.accounts.find((x) => x.id === t.toAccountId)?.balanceMinor ?? 0;
    W.balances.set(t.fromAccountId, bFrom + t.fromAmountMinor);
    W.balances.set(t.toAccountId, bTo - t.toAmountMinor);
    touched.add(t.fromAccountId); touched.add(t.toAccountId);
    if (t.feeMinor > 0 && t.feeAccountId) {
      const bFee = W.balances.get(t.feeAccountId) ?? d.accounts.find((x) => x.id === t.feeAccountId)?.balanceMinor ?? 0;
      W.balances.set(t.feeAccountId, bFee + t.feeMinor);
      touched.add(t.feeAccountId);
    }
  }
  for (const id of touched) {
    const acc = d.accounts.find((x) => x.id === id);
    if (acc) lines.push(balanceLine(acc, acc.balanceMinor, W.balances.get(id) ?? acc.balanceMinor, warnings));
  }
  lines.push('兩邊帳戶餘額會退回去；這是軟刪除，執行後可以按「還原」全部救回來');
  return {
    op: { kind: 'transfer_delete', ids: hits.map((t) => t.id) },
    preview: { tool, title: hits.length === 1 ? `刪除轉帳：${accName(hits[0].fromAccountId)}→${accName(hits[0].toAccountId)} ${fmt(hits[0].fromAmountMinor, d.baseCurrency)}` : `刪除 ${hits.length} 筆轉帳`, lines, warnings: hits.length > 1 ? [`會一次刪 ${hits.length} 筆，請確認清單`, ...warnings] : warnings, affectedTx: hits.length, accountsTouched: touched.size, accountIds: [...touched] },
  };
}

function manageDebtTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'manage_debt';
  const title = '管理應收／應付';
  const person = str(a.person);
  const action = a.action === 'unsettle' ? 'unsettle' : a.action === 'delete' ? 'delete' : null;
  if (!person || !action) return blockedStep(tool, title, '請說明對象與操作（刪除或取消結清）');
  const wantDir = a.direction === 'they_owe_me' || a.direction === 'i_owe_them' ? a.direction : undefined;
  const amount = num(a.amount);
  let hits = (d.debts ?? []).filter((x) => !W.removedDebts.has(x.id) && x.personName === person && (!wantDir || x.direction === wantDir) && (action === 'delete' || x.settled || W.settled.has(x.id)));
  if (amount > 0) hits = hits.filter((x) => x.amountMinor === minorOf(amount, x.currency));
  if (!hits.length) return blockedStep(tool, title, action === 'unsettle' ? `找不到跟「${person}」的已結清欠款${amount > 0 ? `（金額 ${amount}）` : ''}` : `找不到跟「${person}」的欠款${amount > 0 ? `（金額 ${amount}）` : ''}`);
  if (hits.length > 5) return blockedStep(tool, title, `跟「${person}」有 ${hits.length} 筆符合的欠款，請說明金額`);
  const warnings: string[] = [];
  const lines: string[] = [];
  const touched = new Set<string>();
  const reverseTx = (txId?: string) => {
    if (!txId) return;
    const t = d.txs.find((x) => x.id === txId && !x.deletedAt);
    if (!t) return;
    const effect = t.type === 'income' ? t.accountAmountMinor : -t.accountAmountMinor;
    const before = W.balances.get(t.accountId) ?? d.accounts.find((x) => x.id === t.accountId)?.balanceMinor ?? 0;
    W.balances.set(t.accountId, before - effect);
    touched.add(t.accountId);
    lines.push(`一併刪除關聯帳目：${t.date} ${t.note} ${fmt(t.amountMinor, t.currency)}（餘額退回）`);
  };
  // 這份計畫裡才剛結清的：結清帳目還不在候選帳目裡，直接退回結清時入帳的金額
  const reverseSettle = (debtId: string) => {
    const eff = W.settleEffects.get(debtId);
    if (!eff) return;
    const before = W.balances.get(eff.accountId) ?? d.accounts.find((x) => x.id === eff.accountId)?.balanceMinor ?? 0;
    W.balances.set(eff.accountId, before - eff.delta);
    touched.add(eff.accountId);
    W.settleEffects.delete(debtId);
    lines.push('一併退回這份計畫裡結清時入帳的金額');
  };
  for (const x of hits) {
    lines.push(`${x.direction === 'they_owe_me' ? `${x.personName} 欠我` : `我欠 ${x.personName}`} ${fmt(x.amountMinor, x.currency)}${x.note ? `（${x.note}）` : ''}${x.settled || W.settled.has(x.id) ? '［已結清］' : ''}`);
    if (action === 'delete') {
      reverseTx(x.loanTxId);
      reverseTx(x.settleTransferId);
      reverseSettle(x.id);
      W.removedDebts.add(x.id);
    } else {
      reverseTx(x.settleTransferId);
      reverseSettle(x.id);
      W.settled.delete(x.id);
      x.settled = 0;
    }
  }
  for (const id of touched) {
    const acc = d.accounts.find((x) => x.id === id);
    if (acc) lines.push(balanceLine(acc, acc.balanceMinor, W.balances.get(id) ?? acc.balanceMinor, warnings));
  }
  if (!touched.size) lines.push('帳戶餘額：不受影響');
  if (action === 'delete') warnings.push('欠款紀錄會刪除（關聯帳目是軟刪除）；執行後可按「還原」救回');
  else lines.push('取消結清後，這筆欠款變回未結清，可以重新結清');
  return {
    op: { kind: 'debt_manage', action, debtIds: hits.map((x) => x.id) },
    preview: { tool, title: `${action === 'delete' ? '刪除' : '取消結清'} ${person} 的欠款（${hits.length} 筆）`, lines, warnings, accountsTouched: touched.size, accountIds: [...touched] },
  };
}

function editGoalTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const tool: ToolName = 'edit_goal';
  const title = '修改存錢目標';
  const name = str(a.goal);
  const s = (a.set && typeof a.set === 'object' ? a.set : {}) as Record<string, unknown>;
  const target = num(s.target_amount);
  // null＝取消截止日（要能傳到執行層）；undefined＝沒提到這項
  const deadline = s.deadline === undefined ? undefined : s.deadline === null ? null : dateOrNull(s.deadline);
  if (s.deadline !== undefined && s.deadline !== null && !deadline) return blockedStep(tool, title, '截止日格式不正確');
  const acc = str(s.account) ? findAccount(d.accounts, str(s.account)) : undefined;
  if (str(s.account) && !acc) return blockedStep(tool, title, `找不到帳戶「${str(s.account)}」`);
  const status = s.status === 'active' || s.status === 'archived' ? s.status : undefined;
  const set: Extract<Op, { kind: 'goal_edit' }>['set'] = {};
  if (target > 0) set.targetMinor = minorOf(target, d.baseCurrency);
  if (deadline !== undefined) set.deadline = deadline;
  if (acc) set.linkedAccountIds = [acc.id];
  if (status) set.status = status;
  if (!Object.keys(set).length) return blockedStep(tool, title, '請說明要改什麼（目標金額、截止日、連結帳戶、封存）');
  const draft = W.draftGoals.get(name);
  if (draft) {
    if (set.targetMinor !== undefined) draft.input.targetMinor = set.targetMinor;
    if (set.deadline !== undefined) draft.input.deadline = set.deadline ?? undefined;
    if (set.linkedAccountIds) draft.input.linkedAccountIds = set.linkedAccountIds;
    if (set.status) draft.input.status = set.status;
    return { op: null, preview: { tool, title: `修改目標「${name}」（併入上一步）`, lines: ['直接修改這份計畫裡剛建立的目標，一起建立'], warnings: [], readonly: true } };
  }
  const goal = (d.goals ?? []).find((g) => g.name === name);
  if (!goal) return blockedStep(tool, title, `找不到目標「${name}」`);
  const lines: string[] = [];
  if (set.targetMinor !== undefined) lines.push(`目標金額 ${fmt(goal.targetMinor, goal.currency)} → ${fmt(set.targetMinor, goal.currency)}`);
  if (set.deadline !== undefined) lines.push(`截止日 ${goal.deadline ?? '（未設）'} → ${set.deadline ?? '（取消）'}`);
  if (set.linkedAccountIds) lines.push(`連結帳戶「${acc!.name}」：目標進度＝帳戶餘額＋手動存入`);
  if (set.status) lines.push(set.status === 'archived' ? '封存目標（不再出現在進行中清單）' : '恢復為進行中');
  lines.push('帳戶餘額：不受影響');
  return { op: { kind: 'goal_edit', goalId: goal.id, set }, preview: { tool, title: `修改目標「${name}」`, lines, warnings: [] } };
}

// ───────────── 入口 ─────────────

/** 驗證並模擬整份計畫。回傳每一步的預覽與要執行的操作；不修改傳入的資料（在複本上模擬） */
export function resolvePlan(steps: RawStep[], data: AgentData): ResolvedStep[] {
  // 工作副本：這份計畫裡新建的分類／帳戶／專案直接加進清單，後面的步驟用名稱就找得到（執行時再把草稿 id 換成真的 id）
  const d: AgentData = {
    ...data,
    categories: [...data.categories],
    accounts: [...data.accounts],
    recurring: data.recurring.map((r) => ({ ...r, pendingDates: [...r.pendingDates], template: { ...r.template } })),
    debts: (data.debts ?? []).map((x) => ({ ...x })),
    projects: [...(data.projects ?? [])],
    wishes: (data.wishes ?? []).map((w) => ({ ...w })),
    durables: (data.durables ?? []).map((x) => ({ ...x })),
  };
  const work = data.txs.map((t) => ({ ...t }));
  const draftBudgets = data.budgets.map((b) => ({ ...b }));
  const W: Work = { balances: new Map(data.accounts.map((a) => [a.id, a.balanceMinor])), draftGoals: new Map(), settled: new Set(), shares: new Map(), draftProjects: new Map(), removedDebts: new Set(), settleEffects: new Map(), draftSeq: 0 };
  const out: ResolvedStep[] = [];
  for (const s of steps.slice(0, MAX_STEPS)) {
    const a = (s.args && typeof s.args === 'object' ? s.args : {}) as Record<string, unknown>;
    if (s.tool === 'reclassify') out.push(reclassify(a, d, work));
    else if (s.tool === 'set_budget') out.push(setBudget(a, d, work, draftBudgets));
    else if (s.tool === 'add_recurring') out.push(addRecurring(a, d));
    else if (s.tool === 'prepayment_sim') out.push(prepayment(a, d));
    else if (s.tool === 'add_goal') {
      const r = addGoal(a, d);
      if (r.op?.kind === 'goal') W.draftGoals.set(r.op.input.name, r.op);
      out.push(r);
    }
    else if (s.tool === 'add_rule') out.push(addRule(a, d, work));
    else if (s.tool === 'add_transaction') out.push(addTransactionTool(a, d, W));
    else if (s.tool === 'transfer') out.push(transferTool(a, d, W));
    else if (s.tool === 'add_debt') out.push(addDebtTool(a, d, W));
    else if (s.tool === 'settle_debt') out.push(settleDebtTool(a, d, W));
    else if (s.tool === 'goal_deposit') out.push(goalDepositTool(a, d, W));
    else if (s.tool === 'buy_stock') out.push(tradeStockTool('buy', a, d, W));
    else if (s.tool === 'sell_stock') out.push(tradeStockTool('sell', a, d, W));
    else if (s.tool === 'show_view') out.push(showViewTool(a));
    else if (s.tool === 'edit_transaction') out.push(editTxTool(a, d, work));
    else if (s.tool === 'delete_transaction') out.push(deleteTxTool(a, d, work));
    else if (s.tool === 'add_category') out.push(addCategoryTool(a, d, W));
    else if (s.tool === 'add_account') out.push(addAccountTool(a, d, W));
    else if (s.tool === 'add_project') out.push(addProjectTool(a, d, W));
    else if (s.tool === 'set_travel_mode') out.push(setTravelModeTool(a, d));
    else if (s.tool === 'manage_recurring') out.push(manageRecurringTool(a, d, W));
    else if (s.tool === 'manage_inbox') out.push(manageInboxTool(a, d, W));
    else if (s.tool === 'add_installment') out.push(addInstallmentTool(a, d, W));
    else if (s.tool === 'add_dividend') out.push(addDividendTool(a, d, W));
    else if (s.tool === 'add_wish') out.push(addWishTool(a, d, W));
    else if (s.tool === 'decide_wish') out.push(decideWishTool(a, d));
    else if (s.tool === 'manage_durable') out.push(manageDurableTool(a, d, W));
    else if (s.tool === 'add_watch') out.push(addWatchTool(a, d));
    else if (s.tool === 'delete_transfer') out.push(deleteTransferTool(a, d, W));
    else if (s.tool === 'manage_debt') out.push(manageDebtTool(a, d, W));
    else if (s.tool === 'edit_goal') out.push(editGoalTool(a, d, W));
    else out.push({ op: null, preview: { tool: 'reclassify', title: '不支援的操作', lines: [], warnings: [], blocked: `不支援的操作「${String(s.tool).slice(0, 20)}」` } });
  }
  return out;
}

export interface PlanDiff { affectedTx: number; budgetChanges: number; rulesCreated: number; goalsCreated: number; autoRulesCreated: number; txCreated: number; accountsTouched: number; debtsSettled: number; debtsCreated: number; executable: number; blocked: number; readonly: number }

/** 影響彙總（執行預覽卡最上面那排） */
export function summarizePlan(steps: ResolvedStep[]): PlanDiff {
  const d: PlanDiff = { affectedTx: 0, budgetChanges: 0, rulesCreated: 0, goalsCreated: 0, autoRulesCreated: 0, txCreated: 0, accountsTouched: 0, debtsSettled: 0, debtsCreated: 0, executable: 0, blocked: 0, readonly: 0 };
  const accountIds = new Set<string>();
  for (const s of steps) {
    if (s.preview.blocked) { d.blocked++; continue; }
    if (opsOf(s).length) d.executable++; else if (s.preview.readonly) d.readonly++;
    d.affectedTx += s.preview.affectedTx ?? 0;
    d.budgetChanges += s.preview.budgetChanges ?? 0;
    d.rulesCreated += s.preview.rulesCreated ?? 0;
    d.goalsCreated += s.preview.goalsCreated ?? 0;
    d.autoRulesCreated += s.preview.autoRulesCreated ?? 0;
    d.txCreated += s.preview.txCreated ?? 0;
    for (const id of s.preview.accountIds ?? []) accountIds.add(id);
    d.debtsSettled += s.preview.debtsSettled ?? 0;
    d.debtsCreated += s.preview.debtsCreated ?? 0;
  }
  d.accountsTouched = accountIds.size;
  return d;
}

/**
 * 操作助手（Agent）的「計畫 → 預覽」層，全部是純函式，不碰資料庫、不呼叫 AI。
 *
 * 流程：AI 只產出「工具＋參數」的步驟（伺服器已先做白名單驗證）→ 這裡再驗證一次、把名稱換成 id，
 * 並在「記憶體裡的工作副本」上依序模擬每一步（後面的步驟看得到前面步驟的結果），算出影響預覽
 * （受影響筆數、預算變化、帳戶餘額是否變動）。使用者確認後，才由 services/agent.ts 把同樣的操作真的寫入。
 *
 * 安全：工具白名單；每個工具的參數都重新驗證；一次最多改 MAX_AFFECTED 筆帳目；沒有任何工具會刪帳目。
 * v4.1.0 起動作圖譜擴大到「記帳、轉帳（含還款）、結清欠款、存入目標、買進股票」，預覽會在帳戶餘額的工作副本上依序模擬
 * （後面的步驟看得到前面步驟的結果），並以 show_view 步驟指定要在對話裡嵌入哪張檢視卡（財務自由、稅務、現金流、花費）。
 * 這幾個會動到帳戶的工具目前只支援主幣別帳戶（外幣需要匯率，請用記帳面板）。
 */
import type { Account, Budget, Category, CategoryRule, Goal, RecurringRule, Transaction } from '@/db/types';
import { statAmount } from '@/domain/ledger';
import { currencyInfo, formatMoney } from '@/domain/money';
import { accountingMonth, addDays, type Range } from '@/domain/period';
import { occurrences } from '@/domain/recurrence';
import { loanStatus, simulatePrepayment } from '@/domain/loan';
import { twFee, tradeValue, type TwFeeConfig } from '@/domain/invest/fees-tw';
import { toMinor } from '@/domain/money';
import Decimal from 'decimal.js';

export const MAX_AFFECTED = 500;
export const MAX_STEPS = 8;

export type ToolName = 'reclassify' | 'set_budget' | 'add_recurring' | 'prepayment_sim' | 'add_goal' | 'add_rule'
  | 'add_transaction' | 'transfer' | 'settle_debt' | 'goal_deposit' | 'buy_stock' | 'show_view';
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
  | { kind: 'goal'; input: Omit<Goal, 'id' | 'createdAt' | 'updatedAt'> }
  | { kind: 'rule'; input: Omit<CategoryRule, 'id' | 'createdAt' | 'updatedAt' | 'hits'> }
  | { kind: 'tx'; input: { type: 'expense' | 'income'; accountId: string; categoryId: string; amountMinor: number; currency: string; date: string; note: string } }
  | { kind: 'transfer'; input: { fromAccountId: string; toAccountId: string; amountMinor: number; date: string; note: string } }
  | { kind: 'settle'; debtId: string; accountId?: string }
  | { kind: 'goal_deposit'; goalId: string; amountMinor: number }
  | { kind: 'trade'; input: { stockId: string; accountId: string; date: string; sharesDec: string; priceDec: string; feeMinor: number; cashAccountId: string } };

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
  txCreated?: number;
  debtsSettled?: number;
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
  debts?: { id: string; personName: string; direction: 'they_owe_me' | 'i_owe_them'; amountMinor: number; currency: string; note: string; settled: number }[];
  /** 已有的投資標的（含最新報價）；買進只支援這份清單裡的標的 */
  stocks?: { id: string; symbol: string; name: string; market: string; currency: string; assetType: 'stock' | 'etf' | 'bond_etf'; lotSize: number; priceDec?: string }[];
  feeConfig?: TwFeeConfig;
  defaultBrokerageId?: string;
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

function addGoal(a: Record<string, unknown>, d: AgentData): ResolvedStep {
  const blocked = (why: string): ResolvedStep => ({ op: null, preview: { tool: 'add_goal', title: '建立存錢目標', lines: [], warnings: [], blocked: why } });
  const name = str(a.name).slice(0, 30);
  const amount = num(a.target_amount);
  if (!name || !(amount > 0)) return blocked('目標名稱或金額不正確');
  const cur = d.baseCurrency;
  const targetMinor = minorOf(amount, cur);
  const deadline = dateOrNull(a.deadline);
  const warnings: string[] = [];
  const lines = [`目標金額 ${fmt(targetMinor, cur)}（已存 $0，之後可在「規劃 → 目標」連結帳戶或手動存入）`];
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
    op: { kind: 'goal', input: { start: d.today, name, icon: '🎯', color: '#0A84FF', targetMinor, currency: cur, deadline: deadline && deadline > d.today ? deadline : undefined, linkedAccountIds: [], manualSavedMinor: 0, status: 'active' } },
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
  const amountMinor = minorOf(amount, acc.currency);
  const note = str(a.note).slice(0, 60) || cat.name;
  const before = W.balances.get(acc.id) ?? acc.balanceMinor;
  const after = before + (type === 'income' ? amountMinor : -amountMinor);
  W.balances.set(acc.id, after);
  const warnings: string[] = [];
  const lines = [`${type === 'income' ? '收入' : '支出'}${fmt(amountMinor, acc.currency)}，分類「${cat.name}」，${date}`, balanceLine(acc, before, after, warnings)];
  if (!str(a.category)) warnings.push(`你沒有指定分類，先放在「${cat.name}」`);
  return {
    op: { kind: 'tx', input: { type, accountId: acc.id, categoryId: cat.id, amountMinor, currency: acc.currency, date, note } },
    preview: { tool: 'add_transaction', title: `${type === 'income' ? '收入' : '支出'} ${fmt(amountMinor, acc.currency)}（${note}）→「${acc.name}」`, lines, warnings, txCreated: 1, accountsTouched: 1 },
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
    preview: { tool: 'transfer', title: `轉帳 ${fmt(amountMinor, from.currency)}：「${from.name}」→「${to.name}」`, lines, warnings, txCreated: 1, accountsTouched: 2 },
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
  }
  if (acc) {
    const before = W.balances.get(acc.id) ?? acc.balanceMinor, after = before + total;
    W.balances.set(acc.id, after);
    lines.push(balanceLine(acc, before, after, warnings));
  } else lines.push('沒有指定帳戶：只標記為已結清，不動任何帳戶餘額');
  return {
    op: null,
    ops: hits.map((x) => ({ kind: 'settle', debtId: x.id, accountId: acc?.id }) as Op),
    preview: { tool: 'settle_debt', title: `結清 ${person} 的欠款（${hits.length} 筆，合計 ${fmt(Math.abs(total), d.baseCurrency)}）`, lines, warnings, debtsSettled: hits.length, accountsTouched: acc ? 1 : 0, txCreated: acc ? hits.length : 0 },
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

function buyStockTool(a: Record<string, unknown>, d: AgentData, W: Work): ResolvedStep {
  const title = '買進股票';
  const symbol = str(a.symbol).toUpperCase();
  const stock = (d.stocks ?? []).find((s) => s.symbol.toUpperCase() === symbol);
  if (!stock) return blockedStep('buy_stock', title, `投資頁裡還沒有「${symbol || '（未說明）'}」這檔標的，請先到「帳戶 → 投資」新增一次交易，之後就能用說的買進`);
  // 台股的 market 是 TWSE（上市）、TPEX（上櫃）、EMERGING（興櫃）；美股、港股需要匯率，請到投資頁記錄
  if (!['TWSE', 'TPEX', 'EMERGING'].includes(stock.market) || stock.currency !== d.baseCurrency) return blockedStep('buy_stock', title, `「${stock.symbol}」不是台股／主幣別標的，請到投資頁記錄買進（需要匯率與手續費設定）`);
  const shares = num(a.shares);
  if (!(shares > 0)) return blockedStep('buy_stock', title, '股數必須大於 0');
  const priceGiven = num(a.price);
  const price = priceGiven > 0 ? new Decimal(priceGiven) : stock.priceDec ? new Decimal(stock.priceDec) : null;
  if (!price || price.lte(0)) return blockedStep('buy_stock', title, `沒有「${stock.symbol}」的報價，請說明成交價（例如「買 1000 股 0050，價格 180」）`);
  // 證券戶：投資設定的預設證券戶，沒有就用第一個證券帳戶（和投資頁的交易表單一樣）；扣款帳戶：你說的 → 證券戶的交割帳戶 → 證券戶本身
  const broker = d.accounts.find((x) => x.id === d.defaultBrokerageId && usableAcc(x)) ?? d.accounts.find((x) => usableAcc(x) && x.type === 'brokerage');
  const settle = broker?.brokerage?.settlementAccountId ? d.accounts.find((x) => x.id === broker.brokerage!.settlementAccountId && usableAcc(x)) : undefined;
  const acc = (str(a.account) ? findAccount(d.accounts, str(a.account)) : undefined) ?? settle ?? broker ?? d.accounts.find((x) => usableAcc(x) && x.type === 'bank');
  if (!acc) return blockedStep('buy_stock', title, str(a.account) ? `找不到帳戶「${str(a.account)}」` : '請說明從哪個帳戶扣款');
  if (!baseOnly(acc, d)) return blockedStep('buy_stock', title, '扣款帳戶是外幣帳戶，請到投資頁記錄買進');
  const sharesD = new Decimal(shares);
  const gross = toMinor(tradeValue(price, sharesD), stock.currency);
  const fee = d.feeConfig ? twFee(price, sharesD, d.feeConfig, stock.lotSize) : 0;
  const total = gross + fee;
  const date = dateOrNull(a.date) ?? d.today;
  const before = W.balances.get(acc.id) ?? acc.balanceMinor, after = before - total;
  W.balances.set(acc.id, after);
  const warnings: string[] = [];
  if (priceGiven > 0 && stock.priceDec && Math.abs(priceGiven - Number(stock.priceDec)) / Number(stock.priceDec) > 0.05) warnings.push(`你說的成交價 ${priceGiven} 和最近報價 ${stock.priceDec} 差超過 5%，請確認`);
  if (!(priceGiven > 0)) warnings.push(`沒有指定成交價，先以最近報價 ${stock.priceDec} 試算（實際成交價以券商為準，執行前可改說「價格 xxx」）`);
  const lotText = shares >= 1000 && shares % 1000 === 0 ? `${shares / 1000} 張` : `${shares} 股`;
  return {
    op: { kind: 'trade', input: { stockId: stock.id, accountId: broker?.id ?? acc.id, date, sharesDec: sharesD.toString(), priceDec: price.toString(), feeMinor: fee, cashAccountId: acc.id } },
    preview: {
      tool: 'buy_stock', title: `買進 ${stock.symbol} ${stock.name} ${lotText} @ ${price.toString()}`,
      lines: [`成交金額 ${fmt(gross, stock.currency)}、手續費約 ${fmt(fee, stock.currency)}，共 ${fmt(total, stock.currency)}（${date}）`, balanceLine(acc, before, after, warnings), '會同步記一筆「股票買進」帳目（不計入收支），手續費另記支出'],
      warnings, txCreated: fee > 0 ? 2 : 1, accountsTouched: 1,
    },
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

// ───────────── 入口 ─────────────

/** 驗證並模擬整份計畫。回傳每一步的預覽與要執行的操作；不修改傳入的資料（在複本上模擬） */
export function resolvePlan(steps: RawStep[], data: AgentData): ResolvedStep[] {
  const work = data.txs.map((t) => ({ ...t }));
  const draftBudgets = data.budgets.map((b) => ({ ...b }));
  const W: Work = { balances: new Map(data.accounts.map((a) => [a.id, a.balanceMinor])), draftGoals: new Map(), settled: new Set() };
  const out: ResolvedStep[] = [];
  for (const s of steps.slice(0, MAX_STEPS)) {
    const a = (s.args && typeof s.args === 'object' ? s.args : {}) as Record<string, unknown>;
    if (s.tool === 'reclassify') out.push(reclassify(a, data, work));
    else if (s.tool === 'set_budget') out.push(setBudget(a, data, work, draftBudgets));
    else if (s.tool === 'add_recurring') out.push(addRecurring(a, data));
    else if (s.tool === 'prepayment_sim') out.push(prepayment(a, data));
    else if (s.tool === 'add_goal') {
      const r = addGoal(a, data);
      if (r.op?.kind === 'goal') W.draftGoals.set(r.op.input.name, r.op);
      out.push(r);
    }
    else if (s.tool === 'add_rule') out.push(addRule(a, data, work));
    else if (s.tool === 'add_transaction') out.push(addTransactionTool(a, data, W));
    else if (s.tool === 'transfer') out.push(transferTool(a, data, W));
    else if (s.tool === 'settle_debt') out.push(settleDebtTool(a, data, W));
    else if (s.tool === 'goal_deposit') out.push(goalDepositTool(a, data, W));
    else if (s.tool === 'buy_stock') out.push(buyStockTool(a, data, W));
    else if (s.tool === 'show_view') out.push(showViewTool(a));
    else out.push({ op: null, preview: { tool: 'reclassify', title: '不支援的操作', lines: [], warnings: [], blocked: `不支援的操作「${String(s.tool).slice(0, 20)}」` } });
  }
  return out;
}

export interface PlanDiff { affectedTx: number; budgetChanges: number; rulesCreated: number; goalsCreated: number; autoRulesCreated: number; txCreated: number; accountsTouched: number; debtsSettled: number; executable: number; blocked: number; readonly: number }

/** 影響彙總（執行預覽卡最上面那排） */
export function summarizePlan(steps: ResolvedStep[]): PlanDiff {
  const d: PlanDiff = { affectedTx: 0, budgetChanges: 0, rulesCreated: 0, goalsCreated: 0, autoRulesCreated: 0, txCreated: 0, accountsTouched: 0, debtsSettled: 0, executable: 0, blocked: 0, readonly: 0 };
  for (const s of steps) {
    if (s.preview.blocked) { d.blocked++; continue; }
    if (opsOf(s).length) d.executable++; else if (s.preview.readonly) d.readonly++;
    d.affectedTx += s.preview.affectedTx ?? 0;
    d.budgetChanges += s.preview.budgetChanges ?? 0;
    d.rulesCreated += s.preview.rulesCreated ?? 0;
    d.goalsCreated += s.preview.goalsCreated ?? 0;
    d.autoRulesCreated += s.preview.autoRulesCreated ?? 0;
    d.txCreated += s.preview.txCreated ?? 0;
    d.accountsTouched += s.preview.accountsTouched ?? 0;
    d.debtsSettled += s.preview.debtsSettled ?? 0;
  }
  return d;
}

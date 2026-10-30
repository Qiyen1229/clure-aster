/**
 * 異常與訂閱偵測（純函式，全部在本機用規則計算，不使用 AI、不呼叫伺服器）。
 *
 * 偵測項目：
 *  - subscription：還沒登記成訂閱、卻長得像訂閱的固定扣款（每週／每月／每年，金額穩定）
 *  - price_up：訂閱或固定扣款漲價
 *  - duplicate：疑似重複扣款（同店同金額一兩天內出現兩次，或自動入帳的週期帳目又手動記了一筆）
 *  - large：異常大額（遠高於這個分類平常的花費）
 *  - surge：分類暴增（本月到今天為止，比前三個月同期平均多很多）
 * 每個結果都附白話說明（why）與建議（tip），由模板產生，不經過任何 AI。
 * 為了避免誤報：資料不夠不判斷、金額與次數都要過門檻、分期與已登記的週期帳目不重複提醒。
 */
import type { Transaction } from '@/db/types';
import { countsInStats, statAmount } from './ledger';
import { addDays, fromDateKey, type DateKey, type Range } from './period';
import { median, quantile } from './anomaly-stats';
import { judgeExpense, type Judgment } from './pricing';

export type FindingKind = 'subscription' | 'price_up' | 'duplicate' | 'large' | 'surge';
export type SubPeriod = 'week' | 'month' | 'year';

export interface Finding {
  /** 穩定的 id（同一件事每次偵測都一樣）：用來「略過」與避免重複通知 */
  id: string;
  kind: FindingKind;
  /** warn：建議看一下；info：只是知道一下 */
  severity: 'warn' | 'info';
  title: string;
  /** 白話說明 */
  why: string;
  /** 建議怎麼做 */
  tip: string;
  amountMinor: number;
  date: DateKey;
  txIds: string[];
  /** 「建立為訂閱」需要的資料 */
  subscription?: { name: string; amountMinor: number; period: SubPeriod; nextDate: DateKey; categoryId: string; accountId: string; currency: string; /** 分類是「訂閱」類就登記成訂閱，否則（房租、保費…）登記成一般週期帳目 */ kind: 'subscription' | 'normal' };
}

export interface RuleLike { name: string; template?: { note?: string; merchant?: string } }

export interface DetectInput {
  txs: Transaction[];
  rules: RuleLike[];
  today: DateKey;
  /** 金額顯示（主幣別） */
  fmt: (minor: number) => string;
  /** 分類 id → 主分類名稱 */
  catName: (categoryId: string) => string;
  /** 分類 id → 主分類 id（沒有上層就是自己） */
  mainOf: (categoryId: string) => string;
  /** 分類 id → 子分類名稱與主分類名稱（判斷「這是什麼類型的支出、市價多少」用） */
  catPath?: (categoryId: string) => { name: string; mainName: string };
  /** 主幣別（行情表只適用台幣） */
  baseCurrency?: string;
  /** 分類是不是「訂閱」類（決定登記成訂閱或一般週期帳目）；預設都當訂閱 */
  isSubscriptionCat?: (categoryId: string) => boolean;
  /** 太籠統、不算「店家」的備註（例如「午餐」「早餐」這類分類名稱）：不拿來判斷重複扣款 */
  genericKeys?: ReadonlySet<string>;
  /** 暴增偵測用：本月到今天、與前三個月同一段天數的區間（由 surgeWindows 產生） */
  windows?: { current: Range; prev: Range[] };
}

const DAY = 86400000;
const daysBetween = (a: DateKey, b: DateKey) => Math.round((fromDateKey(b).getTime() - fromDateKey(a).getTime()) / DAY);
const PERIOD_DAYS: Record<SubPeriod, number> = { week: 7, month: 30, year: 365 };
const PERIOD_TEXT: Record<SubPeriod, string> = { week: '每週', month: '每月', year: '每年' };
const PER_YEAR: Record<SubPeriod, number> = { week: 52, month: 12, year: 1 };

export { median } from './anomaly-stats';

/** 店家／備註的比對用鍵：去掉數字、空白、標點與「月費、訂閱」這類贅字 */
export function merchantKey(t: Pick<Transaction, 'merchant' | 'note'>): string {
  return (t.merchant || t.note || '')
    .toLowerCase()
    .replace(/(月費|年費|訂閱|扣款|自動|續約|會員|subscription|monthly|annual)/g, '')
    .replace(/[\d\s\-_.,，。、()（）[\]【】/\\:：#*＊]+/g, '');
}
const labelOf = (t: Pick<Transaction, 'merchant' | 'note'>) => (t.merchant || t.note || '').trim().slice(0, 30);

/** 納入偵測的帳目：一般支出（不含轉帳、投資、餘額調整、分期、不計入統計者） */
function eligible(txs: Transaction[]): Transaction[] {
  return txs.filter((t) => t.type === 'expense' && !t.deletedAt && countsInStats(t) && !t.transferId && !t.stockTradeId && !t.installmentId && statAmount(t) > 0);
}

interface Group { key: string; label: string; txs: Transaction[] }

function groupByMerchant(txs: Transaction[]): Group[] {
  const m = new Map<string, Group>();
  for (const t of txs) {
    const key = merchantKey(t);
    if (key.length < 2) continue;
    const g = m.get(key) ?? { key, label: labelOf(t), txs: [] };
    g.txs.push(t);
    m.set(key, g);
  }
  for (const g of m.values()) g.txs.sort((a, b) => (a.date === b.date ? a.ts - b.ts : a.date < b.date ? -1 : 1));
  return [...m.values()];
}

/** 一組帳目是不是定期扣款：回傳週期與符合程度；不像就回傳 null */
export function detectPeriod(dates: DateKey[]): SubPeriod | null {
  const uniq = [...new Set(dates)].sort();
  if (uniq.length < 2) return null;
  const gaps = uniq.slice(1).map((d, i) => daysBetween(uniq[i], d));
  const fits = (lo: number, hi: number) => gaps.filter((g) => g >= lo && g <= hi).length / gaps.length;
  if (uniq.length >= 4 && fits(6, 8) >= 0.75) return 'week';
  if (uniq.length >= 3 && fits(26, 35) >= 0.75) return 'month';
  if (uniq.length >= 2 && fits(350, 380) >= 0.99) return 'year';
  return null;
}

const nearMedian = (amounts: number[], tol = 0.12) => {
  const med = median(amounts);
  return med > 0 ? amounts.filter((v) => Math.abs(v - med) <= med * tol).length / amounts.length : 0;
};

function isTracked(key: string, rules: RuleLike[]): boolean {
  return rules.some((r) => {
    const rk = merchantKey({ merchant: r.template?.merchant, note: r.template?.note || r.name });
    const nk = merchantKey({ merchant: '', note: r.name });
    return [rk, nk].some((k) => k.length >= 2 && (k === key || key.includes(k) || k.includes(key)));
  });
}

// ───────────── 訂閱與漲價 ─────────────

function detectRecurring(input: DetectInput, pool: Transaction[]): Finding[] {
  const out: Finding[] = [];
  for (const g of groupByMerchant(pool)) {
    // 看最近 14 個月：更早的不再代表現在
    const txs = g.txs.filter((t) => daysBetween(t.date, input.today) <= 430);
    if (txs.length < 2) continue;
    const period = detectPeriod(txs.map((t) => t.date));
    if (!period) continue;
    const amounts = txs.map((t) => statAmount(t));
    // 金額要穩定：先前的幾次（最近一次可能是漲價，先不算）要有七成落在中位數 ±12%
    if (nearMedian(amounts.length > 2 ? amounts.slice(0, -1) : amounts) < 0.7) continue;
    const last = txs[txs.length - 1];
    const sinceLast = daysBetween(last.date, input.today);
    if (sinceLast > PERIOD_DAYS[period] * 1.6) continue; // 好像已經沒在扣了
    const prior = amounts.slice(0, -1);
    const priorMed = median(prior);
    const lastAmt = amounts[amounts.length - 1];

    // 漲價：最近一次比先前的穩定金額高 5% 以上、差額至少 1 元
    if (prior.length >= 2 && priorMed > 0 && lastAmt >= priorMed * 1.05 && lastAmt - priorMed >= 100 && nearMedian(prior) >= 0.7 && sinceLast <= 100) {
      const pct = Math.round(((lastAmt - priorMed) / priorMed) * 100);
      const yearly = Math.round((lastAmt - priorMed) * PER_YEAR[period]);
      out.push({
        id: `price_up:${g.key}:${last.date}`, kind: 'price_up', severity: 'warn',
        title: `${g.label} 漲價了（${input.fmt(Math.round(priorMed))} → ${input.fmt(lastAmt)}）`,
        why: `${g.label} 是${PERIOD_TEXT[period]}固定的扣款，前幾次都是約 ${input.fmt(Math.round(priorMed))}，${last.date.slice(5).replace('-', '/')} 這次變成 ${input.fmt(lastAmt)}，多了 ${pct}%。照這個價格，一年會多花約 ${input.fmt(yearly)}。`,
        tip: '到服務的帳單頁確認是不是漲價或被加了項目；不需要的話可以降級或取消。',
        amountMinor: lastAmt - Math.round(priorMed), date: last.date, txIds: [last.id],
      });
    }

    // 新發現的訂閱：還沒登記的才提醒（已登記的由「訂閱續約」處理）
    const tracked = isTracked(g.key, input.rules) || txs.some((t) => t.recurringRuleId);
    if (tracked) continue;
    const med = Math.round(median(amounts));
    const kind = (input.isSubscriptionCat ?? (() => true))(last.categoryId) ? 'subscription' : 'normal';
    const noun = kind === 'subscription' ? '訂閱' : '固定扣款';
    const nextDate = addDays(last.date, PERIOD_DAYS[period] === 30 ? 30 : PERIOD_DAYS[period]);
    out.push({
      id: `subscription:${g.key}`, kind: 'subscription', severity: 'info',
      title: `${g.label} 看起來是${PERIOD_TEXT[period]}${noun}（約 ${input.fmt(med)}）`,
      why: `${g.label} 已經連續 ${txs.length} 次${PERIOD_TEXT[period]}出現、金額都在 ${input.fmt(med)} 上下，很像固定的${noun === '訂閱' ? '訂閱' : '定期扣款（例如房租、保費）'}，但你還沒把它登記起來。一年大約是 ${input.fmt(med * PER_YEAR[period])}。`,
      tip: kind === 'subscription' ? '登記成訂閱後，續約前會提醒你；不是訂閱的話可以按「略過」。' : '登記成週期帳目後，每期到了會提醒你確認入帳；不需要的話可以按「略過」。',
      amountMinor: med, date: last.date, txIds: txs.slice(-4).map((t) => t.id),
      subscription: { name: g.label, amountMinor: med, period, nextDate, categoryId: last.categoryId, accountId: last.accountId, currency: last.currency, kind },
    });
  }
  return out;
}

// ───────────── 重複扣款 ─────────────

function detectDuplicates(input: DetectInput, pool: Transaction[]): Finding[] {
  const out: Finding[] = [];
  const recent = pool.filter((t) => daysBetween(t.date, input.today) <= 45);
  const seen = new Set<string>();
  const habit = (key: string, amt: number) => pool.filter((t) => merchantKey(t) === key && statAmount(t) === amt && daysBetween(t.date, input.today) <= 90).length;
  const sorted = [...recent].sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      const gap = Math.abs(daysBetween(a.date, b.date));
      if (gap > 3) { if (b.ts - a.ts > 4 * DAY) break; continue; }
      const amt = statAmount(a);
      if (amt !== statAmount(b) || amt < 3000) continue;
      const ka = merchantKey(a), kb = merchantKey(b);
      // 情況一：同店、同帳戶、同金額，一天內出現兩次，而且平常不是這樣的消費習慣
      const sameShop = ka.length >= 2 && !input.genericKeys?.has(ka) && ka === kb && a.accountId === b.accountId && gap <= 1 && habit(ka, amt) <= 3;
      // 情況二：自動入帳的週期帳目，旁邊又有一筆手動記的同金額同分類
      const autoPlusManual = !!a.recurringRuleId !== !!b.recurringRuleId && a.categoryId === b.categoryId && !a.transferId && !b.transferId;
      if (!sameShop && !autoPlusManual) continue;
      const id = `duplicate:${[a.id, b.id].sort().join(':')}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const label = labelOf(a) || labelOf(b) || input.catName(a.categoryId);
      out.push({
        id, kind: 'duplicate', severity: 'warn',
        title: `${label} 可能重複扣款（${input.fmt(amt)} 出現兩次）`,
        why: autoPlusManual
          ? `「${label}」已經由週期帳目自動入帳，${b.date.slice(5).replace('-', '/')} 又有一筆金額相同（${input.fmt(amt)}）、分類相同的手動記帳，可能是同一筆記了兩次。`
          : `${a.date.slice(5).replace('-', '/')} 與 ${b.date.slice(5).replace('-', '/')} 各有一筆 ${label}、同一個帳戶、金額一樣都是 ${input.fmt(amt)}，而且你平常不會這樣連續消費，可能是重複刷卡或重複記帳。`,
        tip: '點進帳目看一下；如果是重複的，刪除其中一筆即可（可以復原）。',
        amountMinor: amt, date: b.date, txIds: [a.id, b.id],
      });
    }
  }
  return out.slice(0, 5);
}

// ───────────── 異常大額（先看習慣、再看分類與市價；大額項目不提醒） ─────────────

/** 判斷一筆支出需要的統計背景（近 210 天的支出） */
export interface ExpenseContext {
  allMedian: number;
  allP95: number;
  byMain: Map<string, number[]>;
  /** 定期出現的固定扣款（房租、保費、訂閱）的店家鍵：本來就是這個金額 */
  periodic: Set<string>;
  size: number;
}

export function expenseContext(pool: Transaction[], today: DateKey, mainOf: (id: string) => string): ExpenseContext {
  const hist = pool.filter((t) => daysBetween(t.date, today) <= 210);
  const all = hist.map((t) => statAmount(t));
  const byMain = new Map<string, number[]>();
  for (const t of hist) {
    const k = mainOf(t.categoryId);
    byMain.set(k, [...(byMain.get(k) ?? []), statAmount(t)]);
  }
  const periodic = new Set(groupByMerchant(hist).filter((g) => detectPeriod(g.txs.map((x) => x.date))).map((g) => g.key));
  return { allMedian: median(all), allP95: quantile(all, 0.95), byMain, periodic, size: hist.length };
}

/** 判斷單筆；已登記的週期帳目、定期固定扣款、資料不足（不到 30 筆）一律不判斷（回傳 null） */
export function judgeOne(input: DetectInput, ctx: ExpenseContext, t: Transaction): Judgment | null {
  if (ctx.size < 30 || t.recurringRuleId || ctx.periodic.has(merchantKey(t))) return null;
  const amt = statAmount(t);
  const main = input.mainOf(t.categoryId);
  const others = [...(ctx.byMain.get(main) ?? [])];
  const idx = others.indexOf(amt);
  if (idx >= 0) others.splice(idx, 1); // 不含這一筆自己
  const path = input.catPath?.(t.categoryId) ?? { name: input.catName(t.categoryId), mainName: input.catName(t.categoryId) };
  return judgeExpense({
    amountMinor: amt, others, allMedian: ctx.allMedian, allP95: ctx.allP95, marketOk: (input.baseCurrency ?? 'TWD') === 'TWD',
    cat: { name: path.name, mainName: path.mainName, note: t.note, merchant: t.merchant },
  });
}

/** 把「超出一般行情」的判斷轉成提醒；reasonExtra 是 AI 查到的市價說明（有的話優先顯示） */
export function highFinding(input: DetectInput, t: Transaction, j: Judgment, reasonExtra?: string): Finding {
  const amt = statAmount(t);
  const label = labelOf(t) || input.catName(t.categoryId);
  const habit = j.habit ? `你平常這個分類一筆約 ${input.fmt(Math.round(j.habit.median))}。` : '';
  let why: string;
  if (reasonExtra) why = `${t.date.slice(5).replace('-', '/')} 這筆 ${input.fmt(amt)}。${reasonExtra}${habit ? ` ${habit}` : ''}`;
  else if (j.basis === 'market' && j.info.range) {
    const [lo, hi] = j.info.range;
    why = `${t.date.slice(5).replace('-', '/')} 這筆 ${input.fmt(amt)}。一般${j.info.why.replace(/屬於.*/, '')}一次消費大約 ${input.fmt(lo * 100)}～${input.fmt(hi * 100)}，這筆是上限的 ${(amt / (hi * 100)).toFixed(1)} 倍。${habit}`;
  } else why = `${t.date.slice(5).replace('-', '/')} 這筆 ${input.fmt(amt)}，遠高於你平常的花費。${habit}`;
  return {
    id: `large:${t.id}`, kind: 'large', severity: 'warn',
    title: `${label} ${input.fmt(amt)} 超出一般行情`,
    why,
    tip: '如果是預期中的花費可以按「略過」；不是的話建議對一下帳單，確認有沒有記錯金額或被盜刷。',
    amountMinor: amt, date: t.date, txIds: [t.id],
  };
}

/** 批次：近 30 天的支出逐筆判斷，只有「依習慣與市價都明顯太高」的才提醒（判斷不了的交給單筆流程，由系統決定要不要請 AI） */
function detectLarge(input: DetectInput, pool: Transaction[]): Finding[] {
  const ctx = expenseContext(pool, input.today, input.mainOf);
  const out: (Finding & { ratio: number })[] = [];
  for (const t of pool.filter((x) => daysBetween(x.date, input.today) <= 30)) {
    const j = judgeOne(input, ctx, t);
    if (j?.verdict !== 'high') continue;
    const f = highFinding(input, t, j);
    out.push({ ...f, ratio: statAmount(t) / Math.max(1, j.marketHigh ?? j.habit?.high ?? 1) });
  }
  return out.sort((a, b) => b.ratio - a.ratio).slice(0, 3).map(({ ratio: _r, ...f }) => f);
}

// ───────────── 分類暴增 ─────────────

/** 本月到今天為止，與前三個月「同一段天數」的比較區間 */
export function surgeWindows(monthRange: Range, today: DateKey, prevMonthStarts: DateKey[]): { current: Range; prev: Range[] } {
  const elapsed = Math.max(1, daysBetween(monthRange.start, today) + 1);
  return {
    current: { start: monthRange.start, end: today },
    prev: prevMonthStarts.map((s) => ({ start: s, end: addDays(s, elapsed - 1) })),
  };
}

function detectSurge(input: DetectInput, pool: Transaction[]): Finding[] {
  const w = input.windows;
  if (!w || w.prev.length < 2) return [];
  const elapsed = daysBetween(w.current.start, w.current.end) + 1;
  if (elapsed < 7) return [];
  const sumBy = (r: Range) => {
    const m = new Map<string, number>();
    for (const t of pool) if (t.date >= r.start && t.date <= r.end) m.set(input.mainOf(t.categoryId), (m.get(input.mainOf(t.categoryId)) ?? 0) + statAmount(t));
    return m;
  };
  const cur = sumBy(w.current);
  const prevs = w.prev.map(sumBy);
  const allMed = median(pool.map((t) => statAmount(t)));
  const out: (Finding & { diff: number })[] = [];
  for (const [cat, v] of cur) {
    const avg = prevs.reduce((a, m) => a + (m.get(cat) ?? 0), 0) / prevs.length;
    if (avg <= 0 || prevs.filter((m) => (m.get(cat) ?? 0) > 0).length < 2) continue;
    const diff = v - avg;
    if (v < avg * 1.5 || diff < Math.max(allMed * 8, 50000)) continue;
    const name = input.catName(cat);
    const pct = Math.round((v / avg - 1) * 100);
    out.push({
      id: `surge:${cat}:${w.current.start}`, kind: 'surge', severity: 'info', diff,
      title: `${name} 本月花得特別多（比平常多 ${pct}%）`,
      why: `本月 1 號到今天（${elapsed} 天）${name} 已經花了 ${input.fmt(v)}；前三個月同樣這段時間平均只有 ${input.fmt(Math.round(avg))}，多了 ${input.fmt(Math.round(diff))}。`,
      tip: '到報表看這個分類裡是哪幾筆拉高的；如果是一次性的支出就不用擔心，否則可以幫這個分類設一個預算。',
      amountMinor: Math.round(diff), date: w.current.end, txIds: [],
    });
  }
  return out.sort((a, b) => b.diff - a.diff).slice(0, 2).map(({ diff: _d, ...f }) => f);
}

// ───────────── 入口 ─────────────

/** 執行全部偵測。結果依嚴重程度與金額排序；用 dismissed 過濾掉使用者略過的 */
export function detectInsights(input: DetectInput, dismissed: ReadonlySet<string> = new Set()): Finding[] {
  const pool = eligible(input.txs);
  if (pool.length < 5) return [];
  const all = [
    ...detectRecurring(input, pool),
    ...detectDuplicates(input, pool),
    ...detectLarge(input, pool),
    ...detectSurge(input, pool),
  ];
  const rank = (f: Finding) => (f.severity === 'warn' ? 0 : 1);
  return all.filter((f) => !dismissed.has(f.id)).sort((a, b) => rank(a) - rank(b) || b.amountMinor - a.amountMinor);
}

/** 訂閱的年化總額（只算「新發現」的那幾項，給摘要用） */
export const yearlyOf = (f: Finding) => (f.subscription ? f.subscription.amountMinor * PER_YEAR[f.subscription.period] : 0);

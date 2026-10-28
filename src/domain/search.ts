/**
 * 全域搜尋（純函式）：把一串輸入拆成多個條件，全部符合才算（AND）。
 *   5000 / 5,000 / $5000 / 5000元      金額（比對原幣、帳戶幣別、主幣別金額；轉帳比對轉出、轉入與手續費）
 *   1000-5000 / 1000~5000 / >=5000 / 5000以上 / 低於300   金額範圍
 *   2026-10-25 / 10/25 / 10月25日 / 2026/10 / 10月       日期（M/D、M月 不限年份）
 *   今天 昨天 前天 本週 上週 本月 上個月 今年 去年 最近   相對日期
 *   支出 / 收入 / 轉帳                                   類型
 *   #旅遊 / @玉山                                        標籤、帳戶（名稱包含）
 *   其他文字                                             備註、商家、發票號碼、分類（含上層分類）、帳戶、標籤、專案
 * 數字同時也會當作文字比對備註（例如備註「訂單 5000」）。轉帳也會被搜尋到。
 */
import type { Account, Category, Project, Tag, Transaction, Transfer } from '@/db/types';
import { fromMinor } from './money';
import { toHalfWidth } from './nlp';
import { accountingMonth, addDays, daysInMonth, weekRange, yearRange, type DateKey } from './period';

export type SearchTerm =
  | { kind: 'text'; value: string }
  | { kind: 'num'; value: number; raw: string }
  | { kind: 'range'; min: number; max: number; label: string }
  | { kind: 'date'; start: DateKey; end: DateKey; label: string }
  | { kind: 'md'; month: number; day: number }
  | { kind: 'month'; month: number }
  | { kind: 'type'; value: 'expense' | 'income' | 'transfer' | 'adjust' }
  | { kind: 'tag'; value: string }
  | { kind: 'account'; value: string };

export interface ParsedSearch { terms: SearchTerm[] }
export interface ParseCtx { today: DateKey; weekStart?: 0 | 1 }

export type SearchItem =
  | { kind: 'tx'; tx: Transaction }
  | { kind: 'transfer'; tr: Transfer };

export interface MatchCtx {
  cats: Map<string, Category>;
  accounts: Map<string, Account>;
  tags: Map<string, Tag>;
  projects?: Map<string, Project>;
  baseCurrency: string;
}

const NUM = '(?:nt\\$|\\$|¥|￥)?(\\d[\\d,]*(?:\\.\\d+)?)(?:元|塊|圓)?';
const RE_RANGE = new RegExp(`^${NUM}[-~～到至]${NUM}$`, 'i');
const RE_CMP = new RegExp(`^(>=|<=|≥|≤|>|<|大於|超過|高於|少於|小於|低於|至少|至多)${NUM}$`, 'i');
const RE_SUFFIX = new RegExp(`^${NUM}(以上|以下|以內|以內)$`, 'i');
const RE_NUM = new RegExp(`^${NUM}$`, 'i');

const TYPE_WORDS: Record<string, 'expense' | 'income' | 'transfer' | 'adjust'> = { 支出: 'expense', 收入: 'income', 轉帳: 'transfer', 轉出: 'transfer', 餘額調整: 'adjust' };

const toNum = (s: string) => Number(s.replace(/,/g, ''));
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const validMD = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(2024, m - 1); // 2024 閏年：允許 2/29

function relativeRange(word: string, ctx: ParseCtx): { start: DateKey; end: DateKey; label: string } | null {
  const t = ctx.today;
  switch (word) {
    case '今天': return { start: t, end: t, label: '今天' };
    case '昨天': return { start: addDays(t, -1), end: addDays(t, -1), label: '昨天' };
    case '前天': return { start: addDays(t, -2), end: addDays(t, -2), label: '前天' };
    case '最近': return { start: addDays(t, -6), end: t, label: '最近 7 天' };
    case '本週': case '這週': case '本周': case '這周': { const r = weekRange(t, ctx.weekStart ?? 0); return { ...r, label: '本週' }; }
    case '上週': case '上周': { const r = weekRange(addDays(weekRange(t, ctx.weekStart ?? 0).start, -1), ctx.weekStart ?? 0); return { ...r, label: '上週' }; }
    case '本月': case '這個月': case '這月': { const r = accountingMonth(t, 1); return { ...r, label: '本月' }; }
    case '上個月': case '上月': { const r = accountingMonth(addDays(accountingMonth(t, 1).start, -1), 1); return { ...r, label: '上個月' }; }
    case '今年': { const r = yearRange(t); return { ...r, label: '今年' }; }
    case '去年': { const r = yearRange(addDays(yearRange(t).start, -1)); return { ...r, label: '去年' }; }
  }
  return null;
}

function parseToken(raw: string, ctx: ParseCtx): SearchTerm | null {
  const tok = raw.trim();
  if (!tok) return null;
  const low = tok.toLowerCase();

  if (/^#.+/.test(tok)) return { kind: 'tag', value: low.slice(1) };
  if (/^@.+/.test(tok)) return { kind: 'account', value: low.slice(1) };
  if (TYPE_WORDS[tok]) return { kind: 'type', value: TYPE_WORDS[tok] };
  const rel = relativeRange(tok, ctx);
  if (rel) return { kind: 'date', ...rel };

  // ── 日期 ──
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(tok) ?? /^(\d{4})年(\d{1,2})月(\d{1,2})[日號号]?$/.exec(tok);
  if (m && validMD(+m[2], +m[3])) { const d = ymd(+m[1], +m[2], +m[3]); return { kind: 'date', start: d, end: d, label: d }; }
  m = /^(\d{4})[-/.](\d{1,2})$/.exec(tok) ?? /^(\d{4})年(\d{1,2})月(?:份)?$/.exec(tok);
  if (m && +m[2] >= 1 && +m[2] <= 12) {
    const y = +m[1], mo = +m[2];
    return { kind: 'date', start: ymd(y, mo, 1), end: ymd(y, mo, daysInMonth(y, mo - 1)), label: `${y}/${mo}` };
  }
  m = /^(\d{1,2})[/-](\d{1,2})$/.exec(tok) ?? /^(\d{1,2})月(\d{1,2})[日號号]?$/.exec(tok); // 不含「.」：12.5 是金額
  if (m && validMD(+m[1], +m[2])) return { kind: 'md', month: +m[1], day: +m[2] };
  m = /^(\d{1,2})月(?:份)?$/.exec(tok);
  if (m && +m[1] >= 1 && +m[1] <= 12) return { kind: 'month', month: +m[1] };

  // ── 金額 ──
  m = RE_RANGE.exec(tok);
  if (m) {
    const a = toNum(m[1]), b = toNum(m[2]);
    return { kind: 'range', min: Math.min(a, b), max: Math.max(a, b), label: `${Math.min(a, b)}～${Math.max(a, b)}` };
  }
  m = RE_CMP.exec(tok);
  if (m) {
    const v = toNum(m[2]);
    const op = m[1];
    if (/^(>=|≥|至少)$/.test(op)) return { kind: 'range', min: v, max: Infinity, label: `≥ ${v}` };
    if (/^(<=|≤|至多)$/.test(op)) return { kind: 'range', min: 0, max: v, label: `≤ ${v}` };
    if (/^(>|大於|超過|高於)$/.test(op)) return { kind: 'range', min: v + 0.01, max: Infinity, label: `> ${v}` };
    return { kind: 'range', min: 0, max: v - 0.01, label: `< ${v}` };
  }
  m = RE_SUFFIX.exec(tok);
  if (m) {
    const v = toNum(m[1]);
    return m[2] === '以上' ? { kind: 'range', min: v, max: Infinity, label: `≥ ${v}` } : { kind: 'range', min: 0, max: v, label: `≤ ${v}` };
  }
  m = RE_NUM.exec(tok);
  if (m) return { kind: 'num', value: toNum(m[1]), raw: low.replace(/[,$]/g, '') };

  return { kind: 'text', value: low };
}

export function parseSearch(input: string, ctx: ParseCtx): ParsedSearch {
  const terms: SearchTerm[] = [];
  for (const tok of toHalfWidth(input).split(/\s+/)) {
    const t = parseToken(tok, ctx);
    if (t) terms.push(t);
  }
  return { terms };
}

/** 條件的簡短說明（搜尋頁顯示「我理解的條件」） */
export function describeTerm(t: SearchTerm): string {
  switch (t.kind) {
    case 'text': return `🔎 ${t.value}`;
    case 'num': return `💰 ${t.value}`;
    case 'range': return `💰 ${t.label}`;
    case 'date': return `📅 ${t.label}`;
    case 'md': return `📅 ${t.month}/${t.day}`;
    case 'month': return `📅 ${t.month} 月`;
    case 'type': return `🏷 ${{ expense: '支出', income: '收入', transfer: '轉帳', adjust: '餘額調整' }[t.value]}`;
    case 'tag': return `# ${t.value}`;
    case 'account': return `@ ${t.value}`;
  }
}

/** 日期條件合併成可以直接查資料庫索引的範圍（沒有就回傳空物件）；M/D、M月 不限年份，不縮小範圍 */
export function dateBounds(q: ParsedSearch): { start?: DateKey; end?: DateKey } {
  let start: DateKey | undefined, end: DateKey | undefined;
  for (const t of q.terms) {
    if (t.kind !== 'date') continue;
    if (!start || t.start > start) start = t.start;
    if (!end || t.end < end) end = t.end;
  }
  return { start, end };
}

const approx = (a: number, b: number) => Math.abs(a - b) < 0.005;
const inRange = (v: number, min: number, max: number) => v >= min - 0.005 && v <= max + 0.005;

function amountsOf(item: SearchItem, ctx: MatchCtx): number[] {
  if (item.kind === 'transfer') {
    const { tr } = item;
    const fromCur = ctx.accounts.get(tr.fromAccountId)?.currency ?? ctx.baseCurrency;
    const toCur = ctx.accounts.get(tr.toAccountId)?.currency ?? ctx.baseCurrency;
    const out = [fromMinor(tr.fromAmountMinor, fromCur).toNumber(), fromMinor(tr.toAmountMinor, toCur).toNumber()];
    if (tr.feeMinor) out.push(fromMinor(tr.feeMinor, fromCur).toNumber());
    return out;
  }
  const { tx } = item;
  const accCur = ctx.accounts.get(tx.accountId)?.currency ?? tx.currency;
  const out = [fromMinor(Math.abs(tx.amountMinor), tx.currency).toNumber(), fromMinor(Math.abs(tx.accountAmountMinor), accCur).toNumber(), fromMinor(Math.abs(tx.baseAmountMinor), ctx.baseCurrency).toNumber()];
  if (tx.split) out.push(fromMinor(tx.split.myShareMinor, tx.currency).toNumber());
  return out;
}

function haystack(item: SearchItem, ctx: MatchCtx): string[] {
  const out: string[] = [];
  const acc = (id?: string) => { const a = id ? ctx.accounts.get(id) : undefined; if (a) out.push(a.name); };
  const tags = (ids: string[]) => ids.forEach((id) => { const t = ctx.tags.get(id); if (t) out.push(t.name); });
  const proj = (id?: string) => { const p = id ? ctx.projects?.get(id) : undefined; if (p) out.push(p.name); };
  if (item.kind === 'transfer') {
    const { tr } = item;
    out.push(tr.note, '轉帳');
    acc(tr.fromAccountId); acc(tr.toAccountId); acc(tr.feeAccountId);
    tags(tr.tagIds); proj(tr.projectId);
  } else {
    const { tx } = item;
    out.push(tx.note, tx.merchant ?? '', tx.invoiceNo ?? '', tx.currency, { expense: '支出', income: '收入', adjust: '餘額調整', transfer_fee: '手續費 轉帳手續費' }[tx.type]);
    const c = ctx.cats.get(tx.categoryId);
    if (c) { out.push(c.name); const p = c.parentId ? ctx.cats.get(c.parentId) : undefined; if (p) out.push(p.name); }
    acc(tx.accountId); tags(tx.tagIds); proj(tx.projectId);
  }
  return out.filter(Boolean).map((s) => s.toLowerCase());
}

function tagNames(item: SearchItem, ctx: MatchCtx): string[] {
  const ids = item.kind === 'tx' ? item.tx.tagIds : item.tr.tagIds;
  return ids.map((id) => ctx.tags.get(id)?.name.toLowerCase()).filter((x): x is string => !!x);
}

function accountNames(item: SearchItem, ctx: MatchCtx): string[] {
  const ids = item.kind === 'tx' ? [item.tx.accountId] : [item.tr.fromAccountId, item.tr.toAccountId];
  return ids.map((id) => ctx.accounts.get(id)?.name.toLowerCase()).filter((x): x is string => !!x);
}

export function matchItem(item: SearchItem, q: ParsedSearch, ctx: MatchCtx): boolean {
  const date = item.kind === 'tx' ? item.tx.date : item.tr.date;
  let hay: string[] | null = null;
  let amounts: number[] | null = null;
  for (const t of q.terms) {
    switch (t.kind) {
      case 'text': hay ??= haystack(item, ctx); if (!hay.some((h) => h.includes(t.value))) return false; break;
      case 'num': {
        amounts ??= amountsOf(item, ctx);
        if (amounts.some((a) => approx(a, t.value))) break;
        hay ??= haystack(item, ctx);
        if (!hay.some((h) => h.includes(t.raw))) return false; // 備註、發票號碼等文字裡有這串數字也算
        break;
      }
      case 'range': amounts ??= amountsOf(item, ctx); if (!amounts.some((a) => inRange(a, t.min, t.max))) return false; break;
      case 'date': if (date < t.start || date > t.end) return false; break;
      case 'md': if (+date.slice(5, 7) !== t.month || +date.slice(8, 10) !== t.day) return false; break;
      case 'month': if (+date.slice(5, 7) !== t.month) return false; break;
      case 'type': {
        const type = item.kind === 'transfer' ? 'transfer' : item.tx.type === 'transfer_fee' ? 'expense' : item.tx.type;
        if (type !== t.value) return false;
        break;
      }
      case 'tag': if (!tagNames(item, ctx).some((n) => n.includes(t.value))) return false; break;
      case 'account': if (!accountNames(item, ctx).some((n) => n.includes(t.value))) return false; break;
    }
  }
  return true;
}

const AGG_RE = /多少|幾|最多|最少|最大|最貴|最高|平均|總共|一共|累計|哪/;

/** 統計式的問法（多少、幾次、最大、平均…）：是在問數字，不是在記帳或找某一筆 */
export function isAggregationQuestion(input: string): boolean {
  const s = toHalfWidth(input).trim();
  return AGG_RE.test(s) || /[?？]$/.test(s);
}

/**
 * 輸入帶有金額條件、而且沒有「多少／平均／最大…」這類統計問法時，是在找某一筆帳目，
 * 應該直接搜尋，不要當成「用問的查帳」（例如「上週 5000」「5000 支出」）。
 */
export function preferPlainSearch(input: string, q: ParsedSearch): boolean {
  return q.terms.some((t) => t.kind === 'num' || t.kind === 'range') && !isAggregationQuestion(input);
}

export interface AiSearchPlan {
  keywords: string[];
  category: string | null;
  account: string | null;
  tag: string | null;
  type: 'expense' | 'income' | 'transfer' | null;
  date_start: string | null;
  date_end: string | null;
  min: number | null;
  max: number | null;
}

/** AI 的搜尋規劃（伺服器已驗證）→ 搜尋條件。分類／帳戶／標籤用名稱比對，和手動輸入同一套邏輯。 */
export function planToSearch(plan: AiSearchPlan): ParsedSearch {
  const terms: SearchTerm[] = [];
  for (const k of plan.keywords) terms.push({ kind: 'text', value: k.toLowerCase() });
  if (plan.category) terms.push({ kind: 'text', value: plan.category.toLowerCase() });
  if (plan.account) terms.push({ kind: 'account', value: plan.account.toLowerCase() });
  if (plan.tag) terms.push({ kind: 'tag', value: plan.tag.toLowerCase() });
  if (plan.type) terms.push({ kind: 'type', value: plan.type });
  if (plan.date_start || plan.date_end) {
    const start = plan.date_start ?? '0000-01-01';
    const end = plan.date_end ?? '9999-12-31';
    terms.push({ kind: 'date', start, end, label: plan.date_start && plan.date_end ? (start === end ? start : `${start}～${end}`) : plan.date_start ? `${start} 起` : `${end} 前` });
  }
  if (plan.min !== null || plan.max !== null) {
    const min = plan.min ?? 0;
    const max = plan.max ?? Infinity;
    terms.push({ kind: 'range', min, max, label: plan.min !== null && plan.max !== null ? `${min}～${max}` : plan.min !== null ? `≥ ${min}` : `≤ ${max}` });
  }
  return { terms };
}

/**
 * 對帳引擎（純函式）：把「銀行／信用卡帳單的明細」和「帳本裡同一個帳戶的帳目」逐筆勾稽。
 *
 * 規則（全部不用 AI，數字由這裡算）：
 *  - 一對一配對：同一類型（支出／收入）、日期相差 ≤ 3 天；金額相同的先配（優先同日、店名相近）
 *  - 金額差異（variance）：店名相近（或差距極小且只有一個候選）、金額差 ≤ 5% 的配成「有差額」，
 *    並判斷原因：外幣交易（匯差）、差約 1.5%（海外交易手續費）、其他
 *  - 漏記（missing）：帳單有、帳本沒有
 *  - 多記（extra）：帳本有、帳單沒有（可能尚未入帳、或重複記了）
 * 金額一律是最小單位的整數；帳單金額視為「帳戶幣別」，帶有外幣資訊的列則與帳本的原幣金額比對。
 */
import { dayGap, shopSimilar } from './dedupe';

export const DAY_TOLERANCE = 3;
/** 金額差距超過這個比例就不算同一筆（避免把不同消費硬配在一起） */
export const VARIANCE_MAX_RATIO = 0.05;

export interface StmtRow {
  id: string;
  date: string;
  /** 正整數（帳戶幣別最小單位）；帳單上的請款金額 */
  amountMinor: number;
  kind: 'expense' | 'income';
  /** 商家／說明 */
  text: string;
  /** 外幣交易的原幣資訊（選填） */
  foreignMinor?: number;
  foreignCurrency?: string;
}

export interface LedgerRow {
  id: string;
  date: string;
  /** 帳目在帳戶幣別的金額（正整數） */
  accountMinor: number;
  /** 帳目輸入的原幣金額與幣別 */
  origMinor: number;
  origCurrency: string;
  kind: 'expense' | 'income';
  text: string;
}

export type VarianceReason = 'fx' | 'overseas_fee' | 'other';

export interface Match {
  stmt: StmtRow;
  ledger: LedgerRow;
  dayGap: number;
  /** 帳單 − 帳本（帳戶幣別）；0＝完全吻合 */
  diffMinor: number;
  reason?: VarianceReason;
}

export interface ReconcileReport {
  matched: Match[];
  variances: Match[];
  missing: StmtRow[];
  extra: LedgerRow[];
  /** 帳單明細合計（支出為正、收入為負的淨支出）與已配對帳目合計的差 */
  stmtTotalMinor: number;
  ledgerMatchedTotalMinor: number;
}

interface Cand { s: StmtRow; l: LedgerRow; gap: number; diff: number; sim: boolean; score: number; exact: boolean; fxMatch: boolean }

function score(s: StmtRow, l: LedgerRow): Cand | null {
  if (s.kind !== l.kind) return null;
  const gap = dayGap(s.date, l.date);
  if (gap > DAY_TOLERANCE) return null;
  const sim = shopSimilar(s.text, l.text);
  // 外幣列：帳單的原幣金額與帳本原幣金額相同就是同一筆（帳戶幣別金額會有匯差）
  const fxMatch = !!s.foreignCurrency && !!s.foreignMinor && l.origCurrency === s.foreignCurrency && l.origMinor === s.foreignMinor;
  const diff = s.amountMinor - l.accountMinor;
  const exact = diff === 0;
  const ratio = l.accountMinor > 0 ? Math.abs(diff) / l.accountMinor : 1;
  if (!exact && !fxMatch && ratio > VARIANCE_MAX_RATIO) return null;
  const rank = (exact ? 100 : fxMatch ? 80 : 40 - ratio * 100) + (gap === 0 ? 6 : 3 - gap) + (sim ? 8 : 0);
  return { s, l, gap, diff, sim, score: rank, exact, fxMatch };
}

function reasonOf(c: Cand, accountCurrency: string): VarianceReason {
  if (c.fxMatch || c.l.origCurrency !== accountCurrency || !!c.s.foreignCurrency) return 'fx';
  const ratio = c.l.accountMinor > 0 ? c.diff / c.l.accountMinor : 0;
  return ratio >= 0.012 && ratio <= 0.018 ? 'overseas_fee' : 'other';
}

/** 勾稽：貪婪一對一配對（先配最有把握的），回傳對帳差異報告 */
export function reconcile(stmt: StmtRow[], ledger: LedgerRow[], accountCurrency: string): ReconcileReport {
  const cands: Cand[] = [];
  for (const s of stmt) for (const l of ledger) {
    const c = score(s, l);
    if (!c) continue;
    // 有差額的配對必須「店名相近」，或差距很小（≤1.5%）且當天；否則太容易配錯
    const ratio = l.accountMinor > 0 ? Math.abs(c.diff) / l.accountMinor : 1;
    if (!c.exact && !c.fxMatch && !c.sim && !(ratio <= 0.015 && c.gap <= 1)) continue;
    cands.push(c);
  }
  cands.sort((a, b) => b.score - a.score || (a.s.id < b.s.id ? -1 : 1));
  const usedS = new Set<string>(), usedL = new Set<string>();
  const matched: Match[] = [], variances: Match[] = [];
  for (const c of cands) {
    if (usedS.has(c.s.id) || usedL.has(c.l.id)) continue;
    usedS.add(c.s.id); usedL.add(c.l.id);
    const m: Match = { stmt: c.s, ledger: c.l, dayGap: c.gap, diffMinor: c.diff };
    if (c.diff === 0) matched.push(m);
    else variances.push({ ...m, reason: reasonOf(c, accountCurrency) });
  }
  const missing = stmt.filter((s) => !usedS.has(s.id));
  // 多記：只看帳單涵蓋的日期範圍（前後各 3 天）內、帳本有而帳單沒有的
  let extra: LedgerRow[] = [];
  if (stmt.length) {
    const dates = stmt.map((s) => s.date).sort();
    const lo = dates[0], hi = dates[dates.length - 1];
    extra = ledger.filter((l) => !usedL.has(l.id) && l.date >= shift(lo, -DAY_TOLERANCE) && l.date <= shift(hi, DAY_TOLERANCE));
  }
  const net = (k: 'expense' | 'income', v: number) => (k === 'expense' ? v : -v);
  return {
    matched, variances, missing, extra,
    stmtTotalMinor: stmt.reduce((a, s) => a + net(s.kind, s.amountMinor), 0),
    ledgerMatchedTotalMinor: [...matched, ...variances].reduce((a, m) => a + net(m.ledger.kind, m.ledger.accountMinor), 0),
  };
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const REASON_LABEL: Record<VarianceReason, string> = {
  fx: '外幣匯差（記帳時用預估匯率，與實際請款金額不同）',
  overseas_fee: '海外交易手續費（約 1.5%）',
  other: '金額不同',
};

/** 補帳時用來猜「這是手續費／年費／利息」類的說明 */
export const FEE_LIKE = /手續費|年費|利息|循環|跨行|匯費|服務費|違約|滯納|逾期/;

/** 一句話白話摘要（新手友善） */
export function summarizeReport(r: ReconcileReport, fmt: (minor: number) => string): string {
  const parts: string[] = [];
  parts.push(`${r.matched.length} 筆完全吻合`);
  if (r.missing.length) parts.push(`${r.missing.length} 筆漏記`);
  if (r.variances.length) {
    const sum = r.variances.reduce((a, v) => a + v.diffMinor, 0);
    parts.push(`${r.variances.length} 筆金額有差（合計差 ${fmt(Math.abs(sum))}）`);
  }
  if (r.extra.length) parts.push(`${r.extra.length} 筆帳本有、帳單沒有`);
  return parts.join('、');
}

/**
 * 對帳的資料與寫入層：把帳單明細（CSV 或 AI 讀出的截圖）轉成 StmtRow、載入帳本資料、依使用者勾選補齊。
 * 比對本身在 domain/reconcile.ts（純函式）。所有「補齊」都走 repo/ledger（維護帳戶餘額），可一鍵復原。
 */
import { db } from '@/db/schema';
import { addTransaction } from '@/db/repo/ledger';
import { FEE_LIKE, type LedgerRow, type Match, type StmtRow } from '@/domain/reconcile';
import { addDays } from '@/domain/period';
import { toMinor } from '@/domain/money';
import { suggestCategory } from './autocat';
import type { ParsedRow } from './importer';
import type { StatementEntry } from './ai';
import type { Account, Category } from '@/db/types';

/** CSV 解析後的列 → 帳單明細（只收支出／收入；金額視為帳戶幣別） */
export function stmtFromCsv(rows: ParsedRow[], accountCurrency: string): StmtRow[] {
  return rows.filter((r) => !r.error && (r.kind === 'expense' || r.kind === 'income') && r.date)
    .map((r, i) => ({ id: `c${i}`, date: r.date, amountMinor: toMinor(r.amount.abs(), accountCurrency), kind: r.kind as 'expense' | 'income', text: r.note || r.merchant || '' }))
    .filter((r) => r.amountMinor > 0);
}

/** AI 讀出的截圖明細 → 帳單明細 */
export function stmtFromAi(entries: StatementEntry[], accountCurrency: string): StmtRow[] {
  return entries.map((e, i) => ({
    id: `a${i}`, date: e.date, amountMinor: toMinor(e.amount, accountCurrency), kind: e.type, text: e.merchant,
    ...(e.foreign_amount && e.foreign_currency ? { foreignMinor: toMinor(e.foreign_amount, e.foreign_currency), foreignCurrency: e.foreign_currency } : {}),
  })).filter((r) => r.amountMinor > 0);
}

/**
 * 「匯差／手續費調整」帳目的備註格式：「<原帳目名稱> 匯差／手續費調整（對帳）·<原帳目 id 末 10 碼（uuidv7 的前段是時間戳，會撞，所以取末段）>」。
 * 下次對帳時據 id 把這筆差額併回原帳目（不靠名稱猜，所以同日同店兩筆、無備註、收入／退款都配得對）；
 * 舊版沒有 id 的調整帳目退回用名稱比對（不限收支、同一筆原帳目不重複配）。
 */
export const ADJ_SUFFIX = ' 匯差／手續費調整（對帳）';
const ADJ_RE = /^(.*?)\s?匯差／手續費調整（對帳）(?:·([0-9a-f]{10}))?$/s;
export const adjustmentNote = (label: string, ledgerId: string) => `${label.trim()}${ADJ_SUFFIX}·${ledgerId.slice(-10)}`;

/** 帳本裡這個帳戶、帳單期間（前後各 3 天）內的收支帳目 */
export async function loadLedgerRows(accountId: string, stmt: StmtRow[]): Promise<LedgerRow[]> {
  if (!stmt.length) return [];
  const dates = stmt.map((s) => s.date).sort();
  const txs = (await db.transactions.where('date').between(addDays(dates[0], -4), addDays(dates[dates.length - 1], 4), true, true).toArray())
    .filter((t) => t.accountId === accountId && !t.deletedAt && !t.transferId && (t.type === 'expense' || t.type === 'income' || t.type === 'transfer_fee'));
  const rows: LedgerRow[] = [];
  const adjustments: { base: string; id8?: string; date: string; kind: 'expense' | 'income'; amount: number }[] = [];
  for (const t of txs) {
    const m = ADJ_RE.exec(t.note);
    if (m) { adjustments.push({ base: m[1].trim(), id8: m[2], date: t.date, kind: t.type === 'income' ? 'income' : 'expense', amount: Math.abs(t.accountAmountMinor) }); continue; }
    rows.push({ id: t.id, date: t.date, accountMinor: Math.abs(t.accountAmountMinor), origMinor: Math.abs(t.amountMinor), origCurrency: t.currency, kind: t.type === 'income' ? 'income' : 'expense', text: `${t.note} ${t.merchant ?? ''}`.trim() });
  }
  // 先前對帳補的差額併回原本那筆：優先用 id；舊資料用名稱＋日期最近，且同一筆原帳目不重複配
  const used = new Set<string>();
  for (const a of adjustments) {
    let target = a.id8 ? rows.find((r) => r.id.endsWith(a.id8!)) : undefined;
    if (!target) {
      target = rows.filter((r) => !used.has(r.id) && (r.text.trim() === a.base || (!r.text.trim() && !a.base)))
        .sort((x, y) => Math.abs(Date.parse(x.date) - Date.parse(a.date)) - Math.abs(Date.parse(y.date) - Date.parse(a.date)))[0];
    }
    if (!target) continue;
    used.add(target.id);
    // 差額方向和原帳目同向（支出對支出、收入對收入）＝金額變大；反向＝變小
    target.accountMinor += (a.kind === target.kind ? 1 : -1) * a.amount;
  }
  return rows;
}

const catByName = (cats: Category[], re: RegExp, kind: 'expense' | 'income') => cats.find((c) => c.kind === kind && !c.archived && !c.deletedAt && !c.system && re.test(c.name));

/** 漏記項目建議的分類：規則／商家記憶 → 手續費類字眼 → 「其他」 */
export async function suggestForMissing(rows: StmtRow[]): Promise<Map<string, string>> {
  const cats = await db.categories.toArray();
  const other = { expense: catByName(cats, /^其他/, 'expense')?.id ?? cats.find((c) => c.kind === 'expense' && !c.system && !c.parentId)?.id ?? '', income: catByName(cats, /^其他/, 'income')?.id ?? cats.find((c) => c.kind === 'income' && !c.system)?.id ?? '' };
  const fee = catByName(cats, /手續費/, 'expense')?.id;
  const out = new Map<string, string>();
  for (const r of rows) {
    const s = await suggestCategory(r.text, r.kind).catch(() => null);
    out.set(r.id, s?.categoryId ?? (r.kind === 'expense' && FEE_LIKE.test(r.text) && fee ? fee : other[r.kind]));
  }
  return out;
}

export interface Fixes {
  missing: { row: StmtRow; categoryId: string }[];
  variances: Match[];
  /** 補齊後要把帳戶餘額校正到這個數字（最小單位；負債帳戶為負數）。null＝不校正 */
  adjustTo: number | null;
}

/**
 * 依勾選補齊並平帳：
 *  - 漏記：新增帳目（帳單上的日期、金額）
 *  - 金額有差：另記一筆差額（匯差／手續費支出，或退回的收入），原帳目不動，帳本有跡可循
 *  - 校正餘額：補完後若與你輸入的實際餘額還有差，才補一筆「餘額調整」
 * 回傳新增的帳目 id（供復原）。
 */
export async function applyFixes(account: Account, f: Fixes): Promise<string[]> {
  const cats = await db.categories.toArray();
  const feeCat = catByName(cats, /手續費/, 'expense')?.id ?? catByName(cats, /^其他/, 'expense')?.id ?? '';
  const refundCat = catByName(cats, /^其他/, 'income')?.id ?? '';
  const ids: string[] = [];
  const at = (date: string) => new Date(`${date}T12:00:00`).getTime();
  for (const m of f.missing) {
    const t = await addTransaction({
      type: m.row.kind, accountId: account.id, categoryId: m.categoryId, amountMinor: m.row.amountMinor, currency: account.currency,
      date: m.row.date, ts: at(m.row.date), note: m.row.text || '（對帳補入）', merchant: m.row.text || undefined,
    });
    ids.push(t.id);
  }
  const otherInc = refundCat;
  for (const v of f.variances) {
    const diff = v.diffMinor;
    if (!diff) continue;
    // 差額帳目的收支方向＝讓「原帳目＋差額」等於帳單金額：支出原帳目帳單較大→再記一筆支出（手續費），較小→收入（退回）；
    // 收入原帳目（退款、入帳）則相反
    const same = diff > 0; // 帳單金額比帳本大
    const type: 'expense' | 'income' = (v.ledger.kind === 'expense') === same ? 'expense' : 'income';
    const categoryId = type === 'expense' ? feeCat : otherInc;
    if (!categoryId) continue;
    const t = await addTransaction({
      type, accountId: account.id, categoryId, amountMinor: Math.abs(diff), currency: account.currency,
      date: v.stmt.date, ts: at(v.stmt.date), note: adjustmentNote(v.ledger.text.trim() || v.stmt.text, v.ledger.id),
    });
    ids.push(t.id);
  }
  if (f.adjustTo !== null) {
    const cur = (await db.accounts.get(account.id))?.balanceMinor ?? 0;
    const delta = f.adjustTo - cur;
    if (delta !== 0) {
      const today = new Date();
      const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const t = await addTransaction({ type: 'adjust', accountId: account.id, categoryId: 'sys-adjust', amountMinor: delta, currency: account.currency, date, ts: Date.now(), note: '對帳餘額校正' });
      ids.push(t.id);
    }
  }
  return ids;
}

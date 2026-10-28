/**
 * 全域搜尋的資料層：依 domain/search 解析出的條件，從資料庫取出帳目與轉帳、篩選、依日期新到舊排序。
 * 有明確日期範圍時直接查日期索引，不用掃全部資料。
 */
import { db } from '@/db/schema';
import type { LedgerItem } from '@/db/repo/ledger';
import { dateBounds, matchItem, type MatchCtx, type ParsedSearch } from '@/domain/search';

export const SEARCH_LIMIT = 300;

export async function searchLedger(q: ParsedSearch, ctx: MatchCtx, limit = SEARCH_LIMIT): Promise<{ items: LedgerItem[]; truncated: boolean }> {
  if (!q.terms.length) return { items: [], truncated: false };
  const { start, end } = dateBounds(q);
  const ranged = start !== undefined || end !== undefined;
  const lo = start ?? '0000-01-01';
  const hi = end ?? '9999-12-31';
  if (lo > hi) return { items: [], truncated: false };
  const [txs, trs] = await Promise.all([
    ranged ? db.transactions.where('date').between(lo, hi, true, true).toArray() : db.transactions.toArray(),
    ranged ? db.transfers.where('date').between(lo, hi, true, true).toArray() : db.transfers.toArray(),
  ]);
  const out: LedgerItem[] = [];
  // 帶 transferId 的帳目是轉帳手續費的附屬列，已由轉帳本身比對（手續費金額）
  for (const tx of txs) {
    if (tx.deletedAt || tx.transferId) continue;
    if (matchItem({ kind: 'tx', tx }, q, ctx)) out.push({ kind: 'tx', id: tx.id, date: tx.date, ts: tx.ts, tx });
  }
  for (const tr of trs) {
    if (tr.deletedAt) continue;
    if (matchItem({ kind: 'transfer', tr }, q, ctx)) out.push({ kind: 'transfer', id: tr.id, date: tr.date, ts: tr.ts, tr });
  }
  out.sort((a, b) => (a.date === b.date ? b.ts - a.ts : a.date < b.date ? 1 : -1));
  return { items: out.slice(0, limit), truncated: out.length > limit };
}

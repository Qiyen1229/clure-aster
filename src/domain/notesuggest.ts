/**
 * 記帳備註的「最近常記」建議：輸入時列出過去記過的同名備註，一點就帶入金額、分類、帳戶與標籤。
 * 沒輸入文字時列出近 90 天最常記的幾筆（例如每天的早餐、咖啡）。
 */
import type { Transaction } from '@/db/types';

export type NoteSourceTx = Pick<Transaction, 'id' | 'type' | 'note' | 'amountMinor' | 'currency' | 'categoryId' | 'accountId' | 'tagIds' | 'ts' | 'deletedAt'
  | 'transferId' | 'installmentId' | 'stockTradeId' | 'dividendId'>;

export interface NoteSuggestion {
  note: string;
  amountMinor: number;
  currency: string;
  categoryId: string;
  accountId: string;
  tagIds: string[];
  /** 過去記過幾次 */
  count: number;
  lastTs: number;
}

const DAY = 86_400_000;

export function rankNoteSuggestions(
  txs: NoteSourceTx[], query: string,
  opts: { type: 'expense' | 'income'; currency: string; now?: number; limit?: number },
): NoteSuggestion[] {
  const now = opts.now ?? Date.now();
  const q = query.trim().toLowerCase();
  const groups = new Map<string, NoteSuggestion & { score: number }>();
  for (const t of txs) {
    if (t.deletedAt || t.type !== opts.type || t.currency !== opts.currency || t.amountMinor <= 0) continue;
    if (t.transferId || t.installmentId || t.stockTradeId || t.dividendId) continue;
    const note = t.note.trim();
    if (!note) continue;
    const key = note.toLowerCase();
    if (q ? !key.includes(q) : now - t.ts > 90 * DAY) continue;
    const g = groups.get(key);
    // 同名備註以「最近一次」的金額、分類、帳戶為準
    if (!g) groups.set(key, { note, amountMinor: t.amountMinor, currency: t.currency, categoryId: t.categoryId, accountId: t.accountId, tagIds: t.tagIds, count: 1, lastTs: t.ts, score: 0 });
    else {
      g.count++;
      if (t.ts > g.lastTs) Object.assign(g, { note, amountMinor: t.amountMinor, categoryId: t.categoryId, accountId: t.accountId, tagIds: t.tagIds, lastTs: t.ts });
    }
  }
  const out = [...groups.entries()].map(([key, g]) => {
    const days = Math.max(0, (now - g.lastTs) / DAY);
    // 常記的、最近記的、開頭就符合的排前面
    g.score = Math.min(g.count, 20) + 6 / (1 + days / 14) + (q && key.startsWith(q) ? 3 : 0);
    return g;
  });
  return out.sort((a, b) => b.score - a.score || b.lastTs - a.lastTs).slice(0, opts.limit ?? 4)
    .map(({ score: _s, ...rest }) => rest);
}

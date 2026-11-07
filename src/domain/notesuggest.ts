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
  /** 這是釘選的常用項目（v4.1.8）：值是釘選當時存的，id 用來取消釘選、累計使用次數 */
  pinnedId?: string;
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

/** 釘選項目 → 建議清單的格式。沒打字：全部列出（用得多的排前面）；打字：備註包含那些字，開頭符合的排前面 */
export function pinnedSuggestions(
  pins: { id: string; note: string; type: string; currency: string; amountMinor: number; categoryId: string; accountId: string; tagIds: string[]; useCount: number; updatedAt: number }[],
  query: string, opts: { type: 'expense' | 'income'; currency: string },
): NoteSuggestion[] {
  const q = query.trim().toLowerCase();
  return pins
    .filter((p) => p.type === opts.type && p.currency === opts.currency && (!q || p.note.toLowerCase().includes(q)))
    .sort((a, b) => Number(!!q && b.note.toLowerCase().startsWith(q)) - Number(!!q && a.note.toLowerCase().startsWith(q)) || b.useCount - a.useCount || b.updatedAt - a.updatedAt)
    .map((p) => ({ note: p.note, amountMinor: p.amountMinor, currency: p.currency, categoryId: p.categoryId, accountId: p.accountId, tagIds: p.tagIds, count: p.useCount, lastTs: p.updatedAt, pinnedId: p.id }));
}

/** 釘選的排最前面（最多 8 個），後面接自動推薦（同備註的不重複，補到最多 4 個） */
export function mergeSuggestions(pinned: NoteSuggestion[], auto: NoteSuggestion[], opts: { maxPinned?: number; maxAuto?: number } = {}): NoteSuggestion[] {
  const head = pinned.slice(0, opts.maxPinned ?? 8);
  const seen = new Set(head.map((p) => p.note.trim().toLowerCase()));
  return [...head, ...auto.filter((a) => !seen.has(a.note.trim().toLowerCase())).slice(0, opts.maxAuto ?? 4)];
}

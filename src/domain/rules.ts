/**
 * 自動分類：使用者規則 ＋ 商家記憶。
 * - 規則：備註／商家文字「包含」「完全相同」或符合正規表示式 → 指定分類（可同時加標籤）。數字越小越優先。
 * - 商家記憶：沒有規則命中時，用過去同樣文字（正規化後）最常用、最近用的分類。
 * 純函式，方便測試；資料讀取在 services/autocat.ts。
 */
import type { CategoryKind } from '@/db/types';

export type RuleMatch = 'contains' | 'equals' | 'regex';

export interface RuleLike {
  id: string;
  keyword: string;
  match: RuleMatch;
  kind: CategoryKind | 'any';
  categoryId: string;
  tagIds?: string[];
  accountId?: string;
  priority: number;
  enabled?: boolean;
}

/** 正規化：全形轉半形、去空白與標點、小寫；讓「全家 FamilyMart」與「全家familymart」視為相同 */
export function normText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

export function ruleMatches(rule: RuleLike, text: string): boolean {
  if (!rule.keyword.trim() || rule.enabled === false) return false;
  if (rule.match === 'regex') {
    try { return new RegExp(rule.keyword, 'i').test(text); } catch { return false; }
  }
  const t = normText(text), k = normText(rule.keyword);
  if (!k) return false;
  return rule.match === 'equals' ? t === k : t.includes(k);
}

/** 依優先順序找第一條命中的規則（kind 不符的略過） */
export function matchRule<R extends RuleLike>(rules: R[], text: string, kind: CategoryKind): R | undefined {
  if (!text.trim()) return undefined;
  return [...rules]
    .filter((r) => r.kind === 'any' || r.kind === kind)
    .sort((a, b) => a.priority - b.priority || b.keyword.length - a.keyword.length)
    .find((r) => ruleMatches(r, text));
}

export interface HistoryItem { text: string; categoryId: string; kind: CategoryKind; ts: number }

/** 商家記憶索引：正規化文字 → 各分類的使用次數與最後使用時間 */
export type MemoryIndex = Map<string, Map<string, { n: number; last: number }>>;

export function buildMemory(items: HistoryItem[]): MemoryIndex {
  const idx: MemoryIndex = new Map();
  for (const it of items) {
    const key = `${it.kind}|${normText(it.text)}`;
    if (key.endsWith('|')) continue;
    let m = idx.get(key);
    if (!m) idx.set(key, (m = new Map()));
    const cur = m.get(it.categoryId) ?? { n: 0, last: 0 };
    m.set(it.categoryId, { n: cur.n + 1, last: Math.max(cur.last, it.ts) });
  }
  return idx;
}

/**
 * 從記憶中找分類：完全相同的文字優先；否則找「以既有文字開頭」的最長者（例如「星巴克 拿鐵」→「星巴克」）。
 * 同一文字對應多個分類時，次數多者勝；次數相同取最近使用。
 */
export function recallCategory(idx: MemoryIndex, text: string, kind: CategoryKind): string | undefined {
  const t = normText(text);
  if (t.length < 2) return undefined;
  const pick = (m: Map<string, { n: number; last: number }>) =>
    [...m.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)[0]?.[0];
  const exact = idx.get(`${kind}|${t}`);
  if (exact) return pick(exact);
  let best: { len: number; m: Map<string, { n: number; last: number }> } | null = null;
  const prefix = `${kind}|`;
  for (const [k, m] of idx) {
    if (!k.startsWith(prefix)) continue;
    const s = k.slice(prefix.length);
    if (s.length >= 2 && t.startsWith(s) && (!best || s.length > best.len)) best = { len: s.length, m };
  }
  return best ? pick(best.m) : undefined;
}

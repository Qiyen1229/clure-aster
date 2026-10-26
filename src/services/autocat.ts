/**
 * 自動分類服務：讀取規則與近一年的帳目，提供 suggestCategory()。
 * 商家記憶索引快取 5 分鐘（記帳時每次打字都會查，不必每次讀整張表）；規則有變更時呼叫 invalidateAutocat()。
 */
import { db, uid } from '@/db/schema';
import type { CategoryKind, CategoryRule } from '@/db/types';
import { addDays, todayKey } from '@/domain/period';
import { buildMemory, matchRule, recallCategory, type MemoryIndex } from '@/domain/rules';

export interface CategorySuggestion {
  categoryId: string;
  tagIds: string[];
  source: 'rule' | 'memory';
  ruleId?: string;
}

let cache: { at: number; rules: CategoryRule[]; memory: MemoryIndex } | null = null;
const TTL = 5 * 60 * 1000;

export function invalidateAutocat(): void {
  cache = null;
}

async function load() {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const since = addDays(todayKey(), -365);
  const [rules, txs, cats] = await Promise.all([
    db.rules.toArray(),
    db.transactions.where('date').aboveOrEqual(since).toArray(),
    db.categories.toArray(),
  ]);
  const live = new Set(cats.filter((c) => !c.archived && !c.deletedAt).map((c) => c.id));
  const items = txs
    .filter((t) => !t.deletedAt && (t.type === 'expense' || t.type === 'income') && live.has(t.categoryId) && !t.stockTradeId && !t.dividendId)
    .flatMap((t) => [t.merchant, t.note].filter((x): x is string => !!x?.trim()).map((text) => ({ text, categoryId: t.categoryId, kind: t.type as CategoryKind, ts: t.ts })));
  cache = { at: Date.now(), rules: rules.filter((r) => !r.deletedAt && live.has(r.categoryId)), memory: buildMemory(items) };
  return cache;
}

/** 依備註／商家文字建議分類：規則優先，其次是商家記憶 */
export async function suggestCategory(text: string, kind: CategoryKind): Promise<CategorySuggestion | null> {
  if (!text.trim()) return null;
  const { rules, memory } = await load();
  const r = matchRule(rules, text, kind);
  if (r) return { categoryId: r.categoryId, tagIds: r.tagIds ?? [], source: 'rule', ruleId: r.id };
  const c = recallCategory(memory, text, kind);
  return c ? { categoryId: c, tagIds: [], source: 'memory' } : null;
}

/** 規則被採用時累計命中次數（不影響排序，只給設定頁參考） */
export async function countRuleHit(ruleId: string): Promise<void> {
  await db.rules.where('id').equals(ruleId).modify((r) => { r.hits = (r.hits ?? 0) + 1; });
}

export async function saveRule(input: Omit<CategoryRule, 'id' | 'createdAt' | 'updatedAt' | 'hits'> & { id?: string }): Promise<CategoryRule> {
  const now = Date.now();
  const old = input.id ? await db.rules.get(input.id) : undefined;
  const row: CategoryRule = { hits: 0, ...old, ...input, id: input.id ?? uid(), createdAt: old?.createdAt ?? now, updatedAt: now };
  await db.rules.put(row);
  invalidateAutocat();
  return row;
}

export async function deleteRule(id: string): Promise<void> {
  await db.rules.delete(id);
  invalidateAutocat();
}

/**
 * 從歷史帳目找出「適合建立規則」的文字：同一個文字出現 3 次以上、而且幾乎都記在同一個分類，尚未有規則涵蓋。
 */
export async function ruleCandidates(limit = 8): Promise<{ text: string; categoryId: string; kind: CategoryKind; count: number }[]> {
  const { rules, memory } = await load();
  const out: { text: string; categoryId: string; kind: CategoryKind; count: number }[] = [];
  for (const [key, m] of memory) {
    const [kind, text] = key.split('|') as [CategoryKind, string];
    const total = [...m.values()].reduce((s, v) => s + v.n, 0);
    const [top] = [...m.entries()].sort((a, b) => b[1].n - a[1].n);
    if (!top || total < 3 || top[1].n / total < 0.8) continue;
    if (matchRule(rules, text, kind)) continue;
    out.push({ text, categoryId: top[0], kind, count: total });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, limit);
}

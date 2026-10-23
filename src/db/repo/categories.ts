import { db, uid } from '../schema';
import type { Category, CategoryKind } from '../types';
import { OTHER_SUB_ICON, OTHER_SUB_NAME } from '../seed/categories';
import { markBaseline } from '../sync-tracking';

/** 不出現在分類選擇器的系統分類 */
const HIDDEN_SYSTEM = /^(adjust|transfer_fee|stock_buy|stock_sell|debt_out|debt_in)$/;

export async function addCategory(input: Pick<Category, 'kind' | 'parentId' | 'name' | 'icon' | 'color'>): Promise<Category> {
  const siblings = await db.categories.where('[kind+parentId]').equals([input.kind, input.parentId]).count();
  const now = Date.now();
  const row: Category = { ...input, id: uid(), sort: siblings, archived: 0, createdAt: now, updatedAt: now };
  await db.transaction('rw', db.categories, async () => {
    await db.categories.add(row);
    // 新的主分類自動附上「其他」子分類
    if (!row.parentId && row.name !== OTHER_SUB_NAME) await db.categories.add(otherSubFor(row, 0, now));
  });
  return row;
}

function otherSubFor(main: Category, sort: number, now: number): Category {
  return {
    id: `${main.id}-other`, kind: main.kind, parentId: main.id, name: OTHER_SUB_NAME, icon: OTHER_SUB_ICON,
    color: main.color, sort, archived: 0, createdAt: now, updatedAt: now,
  };
}

/**
 * 確保每個主分類都有「其他」子分類（排在最後）。
 * 例外：本身就叫「其他」的主分類、隱藏的系統分類、已封存的主分類。
 * 若「其他」被封存則恢復。回傳新增或恢復的筆數。
 */
export async function ensureOtherSubcategories(): Promise<number> {
  return db.transaction('rw', db.categories, async (tx) => {
    markBaseline(tx);
    const all = await db.categories.toArray();
    const now = Date.now();
    const toAdd: Category[] = [];
    const toRestore: string[] = [];
    for (const main of all) {
      if (main.parentId || main.archived || main.name === OTHER_SUB_NAME || (main.system && HIDDEN_SYSTEM.test(main.system))) continue;
      const subs = all.filter((c) => c.parentId === main.id);
      const other = subs.find((c) => c.name === OTHER_SUB_NAME);
      if (other) { if (other.archived) toRestore.push(other.id); continue; }
      // id 理論上不會撞到；保險起見撞到就加上亂數
      const sub = otherSubFor(main, subs.length ? Math.max(...subs.map((c) => c.sort)) + 1 : 0, now);
      if (all.some((c) => c.id === sub.id)) sub.id = `${sub.id}-${uid().slice(0, 6)}`;
      toAdd.push(sub);
    }
    if (toAdd.length) await db.categories.bulkAdd(toAdd);
    if (toRestore.length) await db.categories.where('id').anyOf(toRestore).modify({ archived: 0, updatedAt: now });
    return toAdd.length + toRestore.length;
  });
}

export async function updateCategory(id: string, patch: Partial<Pick<Category, 'name' | 'icon' | 'color' | 'archived' | 'parentId'>>): Promise<void> {
  await db.transaction('rw', db.categories, async () => {
    await db.categories.update(id, { ...patch, updatedAt: Date.now() });
    // 主分類換色時，子分類跟著換
    if (patch.color) {
      await db.categories.where('parentId').equals(id).modify({ color: patch.color });
    }
  });
}

export async function reorderCategories(idsInOrder: string[]): Promise<void> {
  await db.transaction('rw', db.categories, async () => {
    for (let i = 0; i < idsInOrder.length; i++) await db.categories.update(idsInOrder[i], { sort: i });
  });
}

/** 沒被使用才刪除，否則封存（避免歷史帳目失去分類） */
export async function deleteOrArchiveCategory(id: string): Promise<'deleted' | 'archived'> {
  const children = await db.categories.where('parentId').equals(id).toArray();
  const ids = [id, ...children.map((c) => c.id)];
  const used = await db.transactions.where('categoryId').anyOf(ids).count();
  if (used > 0) {
    await db.categories.where('id').anyOf(ids).modify({ archived: 1, updatedAt: Date.now() });
    return 'archived';
  }
  await db.categories.bulkDelete(ids);
  return 'deleted';
}

export interface CategoryTree {
  main: Category;
  subs: Category[];
}

export function buildTree(all: Category[], kind: CategoryKind, includeArchived = false): CategoryTree[] {
  const visible = all.filter((c) => c.kind === kind && !(c.system && HIDDEN_SYSTEM.test(c.system)) && (includeArchived || !c.archived));
  const mains = visible.filter((c) => !c.parentId).sort((a, b) => a.sort - b.sort);
  return mains.map((main) => ({
    main,
    subs: visible.filter((c) => c.parentId === main.id).sort((a, b) => a.sort - b.sort),
  }));
}

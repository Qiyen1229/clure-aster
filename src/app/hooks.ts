/**
 * 共用資料 hooks：以 Dexie liveQuery 為單一真相來源，資料變更時自動重新渲染。
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '@/db/schema';
import type { Account, Category, Project, Tag } from '@/db/types';

export function useAccounts(includeArchived = false) {
  const list = useLiveQuery(() => db.accounts.orderBy('sort').toArray(), []);
  return useMemo(() => {
    const all = list ?? [];
    const visible = includeArchived ? all : all.filter((a) => !a.archived);
    return { list: visible, all, map: new Map<string, Account>(all.map((a) => [a.id, a])), loading: !list };
  }, [list, includeArchived]);
}

export function useCategories() {
  const list = useLiveQuery(() => db.categories.toArray(), []);
  return useMemo(() => {
    const all = list ?? [];
    return { all, map: new Map<string, Category>(all.map((c) => [c.id, c])), loading: !list };
  }, [list]);
}

export function useTags() {
  const list = useLiveQuery(() => db.tags.orderBy('sort').toArray(), []);
  return useMemo(() => ({ list: list ?? [], map: new Map<string, Tag>((list ?? []).map((t) => [t.id, t])) }), [list]);
}

export function useProjects() {
  const list = useLiveQuery(() => db.projects.toArray(), []);
  return useMemo(() => ({ list: list ?? [], map: new Map<string, Project>((list ?? []).map((p) => [p.id, p])) }), [list]);
}

/** 分類顯示名稱：「主分類 · 子分類」 */
export function categoryLabel(map: Map<string, Category>, id: string): string {
  const c = map.get(id);
  if (!c) return '未分類';
  const parent = c.parentId ? map.get(c.parentId) : undefined;
  return parent ? `${parent.name} · ${c.name}` : c.name;
}

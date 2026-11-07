/**
 * 釘選的常用記帳（v4.1.8）：把偶爾才記、不是固定週期的消費（例如「肯德基 晚餐 $160」）存起來，
 * 之後在記帳面板一點就帶入金額、分類、帳戶、標籤。
 *
 * 存在 `templates` 資料表（v4.0.7 以前的「範本」，表一直保留、會同步與備份）：舊範本自動變成釘選項目，不需要資料遷移。
 * 釘選存的是「當時的樣子」（不像自動推薦永遠取最近一次），不受近 90 天、最近 800 筆的限制；用得越多排越前面。
 */
import { db, uid } from '../schema';
import type { Template } from '../types';

export const MAX_PINNED = 20;

export interface PinSnapshot {
  type: 'expense' | 'income';
  note: string;
  amountMinor: number;
  currency: string;
  categoryId: string;
  accountId: string;
  tagIds: string[];
  projectId?: string;
}

/** 同一個釘選的判斷：收支類型＋備註（不分大小寫、前後空白）＋幣別 */
export const pinKey = (type: string, note: string, currency: string) => `${type}|${note.trim().toLowerCase()}|${currency}`;

/** 一個範本在記帳面板上的備註（舊範本沒有 note 時用範本名稱） */
export const pinNote = (t: Pick<Template, 'name' | 'payload'>) => (t.payload.note?.trim() || t.name.trim());

export function isUsablePin(t: Template): boolean {
  const p = t.payload;
  return !t.deletedAt && (p.type === 'expense' || p.type === 'income') && (p.amountMinor ?? 0) > 0 && !!p.categoryId && !!p.accountId && !!pinNote(t);
}

/** 常用越多、越近期用過排越前面 */
export function sortPinned(list: Template[]): Template[] {
  return [...list].sort((a, b) => b.useCount - a.useCount || b.updatedAt - a.updatedAt);
}

export async function listPinned(): Promise<Template[]> {
  return sortPinned((await db.templates.toArray()).filter(isUsablePin));
}

export function findPinned(list: Template[], s: Pick<PinSnapshot, 'type' | 'note' | 'currency'>): Template | undefined {
  const k = pinKey(s.type, s.note, s.currency);
  return list.find((t) => pinKey(t.payload.type ?? 'expense', pinNote(t), t.payload.currency ?? '') === k);
}

/** 釘選。已經有同一個（類型＋備註＋幣別）就更新成這次的內容。超過上限會丟錯。 */
export async function pinTransaction(s: PinSnapshot): Promise<{ id: string; created: boolean }> {
  const note = s.note.trim().slice(0, 60);
  if (!note) throw new Error('要有備註才能釘選（例如「肯德基 晚餐」）');
  if (!(s.amountMinor > 0)) throw new Error('要有金額才能釘選');
  const now = Date.now();
  const payload: Template['payload'] = { type: s.type, accountId: s.accountId, categoryId: s.categoryId, amountMinor: s.amountMinor, currency: s.currency, note, tagIds: s.tagIds, ...(s.projectId ? { projectId: s.projectId } : {}) };
  const all = (await db.templates.toArray()).filter((t) => !t.deletedAt);
  const hit = findPinned(all.filter(isUsablePin), { type: s.type, note, currency: s.currency });
  if (hit) { await db.templates.update(hit.id, { name: note, payload, updatedAt: now }); return { id: hit.id, created: false }; }
  if (all.filter(isUsablePin).length >= MAX_PINNED) throw new Error(`最多釘選 ${MAX_PINNED} 個，請先取消不常用的`);
  const id = uid();
  await db.templates.add({ id, name: note, payload, sort: now, useCount: 0, createdAt: now, updatedAt: now });
  return { id, created: true };
}

export async function unpin(id: string): Promise<void> {
  await db.templates.delete(id);
}

/** 套用一次：用得越多排越前面（不更新 updatedAt 以外的內容） */
export async function touchPinned(id: string): Promise<void> {
  const t = await db.templates.get(id);
  if (t) await db.templates.update(id, { useCount: t.useCount + 1, updatedAt: Date.now() });
}

export async function updatePinnedAmount(id: string, amountMinor: number): Promise<void> {
  const t = await db.templates.get(id);
  if (!t || !(amountMinor > 0)) return;
  await db.templates.update(id, { payload: { ...t.payload, amountMinor }, updatedAt: Date.now() });
}

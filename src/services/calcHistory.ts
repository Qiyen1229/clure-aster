/**
 * 計算機的記錄：最近算過的幾筆（預設 10 筆，可選 5／10／20／50）。
 * 存在這個帳號的本機資料庫（meta 表，不同步、不進備份）；換帳號不會看到彼此的算式。
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { db, uid } from '@/db/schema';

export interface CalcEntry { id: string; expr: string; result: string; at: number }

const HISTORY_KEY = 'calc.history';
const KEEP_KEY = 'calc.keep';
export const KEEP_CHOICES = [5, 10, 20, 50] as const;
export const DEFAULT_KEEP = 10;

async function read(): Promise<{ list: CalcEntry[]; keep: number }> {
  const [h, k] = await Promise.all([db.meta.get(HISTORY_KEY), db.meta.get(KEEP_KEY)]);
  const keep = (KEEP_CHOICES as readonly number[]).includes(k?.value as number) ? (k!.value as number) : DEFAULT_KEEP;
  return { list: (Array.isArray(h?.value) ? (h!.value as CalcEntry[]) : []).slice(0, keep), keep };
}

export function useCalcHistory(): { list: CalcEntry[]; keep: number } {
  return useLiveQuery(read, [], { list: [], keep: DEFAULT_KEEP }) ?? { list: [], keep: DEFAULT_KEEP };
}

/** 記下一筆結果（最新的排最前；和最前面一筆完全相同就不重複記） */
export async function pushCalc(expr: string, result: string): Promise<void> {
  const { list, keep } = await read();
  if (list[0] && list[0].expr === expr && list[0].result === result) return;
  await db.meta.put({ key: HISTORY_KEY, value: [{ id: uid(), expr, result, at: Date.now() }, ...list].slice(0, keep) });
}

export async function clearCalc(): Promise<void> {
  await db.meta.put({ key: HISTORY_KEY, value: [] });
}

/** 改保存筆數：變少時立刻裁掉多的 */
export async function setCalcKeep(n: number): Promise<void> {
  const { list } = await read();
  await db.meta.put({ key: KEEP_KEY, value: n });
  await db.meta.put({ key: HISTORY_KEY, value: list.slice(0, n) });
}

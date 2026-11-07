/**
 * PIN 輸錯次數的保存與「連錯 10 次清除本機資料」。
 * 次數同時寫在 localStorage 與 IndexedDB（本機資料庫的 meta 表）：只清掉其中一邊（例如在電腦上刪掉 localStorage 的
 * `clure.lock.fails`）重置不了，讀取時取兩邊較大的次數與較晚的等待時間。
 */
import { db } from '@/db/schema';

export const WIPE_AT = 10;
const LS_KEY = 'clure.lock.fails';
const META_KEY = 'lock.fails';

export interface Fails { fails: number; until: number }

export function readFailsSync(): Fails {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
    return { fails: Number(v.fails) || 0, until: Number(v.until) || 0 };
  } catch { return { fails: 0, until: 0 }; }
}

/** 兩邊合併：次數取大、等待時間取晚 */
export async function readFails(): Promise<Fails> {
  const a = readFailsSync();
  try {
    const row = await db.meta.get(META_KEY);
    const v = (row?.value ?? {}) as Partial<Fails>;
    return { fails: Math.max(a.fails, Number(v.fails) || 0), until: Math.max(a.until, Number(v.until) || 0) };
  } catch { return a; }
}

export async function writeFails(fails: number, until: number): Promise<void> {
  try {
    if (!fails) localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, JSON.stringify({ fails, until }));
  } catch { /* 私密瀏覽等情況無法儲存 */ }
  try {
    if (!fails) await db.meta.delete(META_KEY);
    else await db.meta.put({ key: META_KEY, value: { fails, until } });
  } catch { /* 資料庫暫時不能寫：退回只靠 localStorage */ }
}

/** 登出（盡力通知伺服器撤銷這台裝置）並刪除這台裝置的本機資料庫，然後回到登入頁。伺服器上的同步資料不受影響。 */
export async function wipeLocalData(): Promise<void> {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': decodeURIComponent((document.cookie.match(/(?:^|;\s*)(?:__Host-)?csrf_token=([^;]+)/)?.[1]) ?? '') } }); } catch { /* 沒網路也照清 */ }
  try { await db.delete(); } catch { /* 刪不掉就關閉連線後再試一次 */ db.close(); try { await db.delete(); } catch { /* 忽略 */ } }
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('clure.') || k.startsWith('aster.')) localStorage.removeItem(k);
    sessionStorage.clear();
  } catch { /* 忽略 */ }
  location.replace('/login');
}

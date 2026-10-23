/**
 * 跨裝置同步引擎（與自架後端 /api/sync/*）。
 *
 * 流程：
 * - 本機每次寫入都會由 DBCore 中介層記到 sync_outbox（見 db/sync-tracking.ts）
 * - 上傳：讀取 outbox，附上每筆資料「當下」的內容（讀不到 = 已刪除）分批送出；伺服器以變更時間做「最後寫入者勝」，
 *   不採用的會回傳伺服器版本，直接套用
 * - 下載：以伺服器游標（meta: sync.cursor）取回其他裝置的變更並套用；本機若有更新的未上傳版本則保留本機
 * - 套用後重算帳戶餘額（餘額為快取，每台裝置自行由帳目算出），設定有變更則重新載入
 *
 * 首次在這台裝置同步：先把既有資料排入 outbox（預設資料的變更時間記為 0，伺服器有版本就以伺服器為準），
 * 先下載再上傳 → 新裝置登入後直接拿到其他裝置的帳目與設定，不會再出現首次設定畫面。
 *
 * 時機：登入後立即、本機變更後約 1 秒、畫面可見時每 15 秒（背景每 60 秒）、切回 App、恢復網路、登出前。
 */
import { create } from 'zustand';
import { db, uid } from '@/db/schema';
import {
  DEVICE_ONLY_SETTINGS, markRemote, outboxId, setLocalChangeListener, SYNCED_TABLES, type OutboxEntry, type SyncedTable,
} from '@/db/sync-tracking';
import { recomputeBalances } from '@/db/repo/accounts';
import { loadSettings } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';
import { api, ApiError } from './api';

export interface SyncChange {
  table: string;
  /** 主鍵的 JSON 字串 */
  key: string;
  updated_at: number;
  deleted: boolean;
  payload: Record<string, unknown> | null;
}

interface PushResponse { accepted: number; rejected: SyncChange[]; cursor: number }
interface PullResponse { changes: SyncChange[]; cursor: number; has_more: boolean }
interface StatusResponse { enabled: boolean; protocol_version: number; records: number; cursor: number }

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'offline' | 'error';

export const useSync = create<{ phase: SyncPhase; lastSyncAt: number | null; pending: number; error: string }>(() => ({
  phase: 'off', lastSyncAt: null, pending: 0, error: '',
}));

const SYNCED = new Set<string>(SYNCED_TABLES);
const META_CURSOR = 'sync.cursor';
const META_DEVICE = 'sync.deviceId';
const META_INIT = 'sync.initialized';
/** 每批上傳的上限（筆數、約略位元組），避免超過 nginx 的請求大小限制 */
const PUSH_BATCH = 400;
const PUSH_BYTES = 1_500_000;
const BALANCE_TABLES = new Set(['accounts', 'transactions', 'transfers']);

async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}
async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

async function deviceId(): Promise<string> {
  let id = await getMeta<string>(META_DEVICE);
  if (!id) {
    id = `d-${uid()}`;
    await setMeta(META_DEVICE, id);
  }
  return id;
}

/** 首次同步前的既有資料：預設／未修改過的資料記為 0，修改過的以修改時間為準 */
function initialAt(row: Record<string, unknown>): number {
  const c = row.createdAt, u = row.updatedAt;
  return typeof c === 'number' && typeof u === 'number' && u > c + 1000 ? u : 0;
}

async function enqueueExistingData(): Promise<void> {
  for (const name of SYNCED_TABLES) {
    const table = db.table(name);
    const kp = table.schema.primKey.keyPath;
    const rows = (await table.toArray()) as Record<string, unknown>[];
    if (!rows.length) continue;
    const keyOf = (r: Record<string, unknown>) => (Array.isArray(kp) ? kp.map((p) => r[p]) : r[kp as string]);
    const entries: OutboxEntry[] = [];
    for (const r of rows) {
      const key = keyOf(r);
      if (name === 'settings' && DEVICE_ONLY_SETTINGS.has(String(key))) continue;
      entries.push({ id: outboxId(name, key), table: name, key, at: initialAt(r) });
    }
    // 已在佇列中的（有真實變更時間）保留不覆蓋
    const existing = new Set((await db.sync_outbox.bulkGet(entries.map((e) => e.id))).filter(Boolean).map((e) => e!.id));
    await db.sync_outbox.bulkPut(entries.filter((e) => !existing.has(e.id)));
  }
  await setMeta(META_INIT, true);
}

/** 套用伺服器的變更；回傳實際有變動的資料表 */
export async function applyRemoteChanges(changes: SyncChange[]): Promise<Set<string>> {
  const touched = new Set<string>();
  const list = changes.filter((c) => SYNCED.has(c.table));
  if (!list.length) return touched;
  const tables = [...new Set(list.map((c) => c.table))].map((t) => db.table(t));
  await db.transaction('rw', [...tables, db.sync_outbox], async (tx) => {
    markRemote(tx);
    for (const c of list) {
      let key: unknown;
      try { key = JSON.parse(c.key); } catch { continue; }
      if (c.table === 'settings' && DEVICE_ONLY_SETTINGS.has(String(key))) continue;
      const oid = outboxId(c.table, key);
      const pending = await db.sync_outbox.get(oid);
      // 本機有更新、尚未上傳的版本 → 保留本機，稍後上傳
      if (pending && pending.at > c.updated_at) continue;
      const table = db.table(c.table);
      if (c.deleted) await table.delete(key as string);
      else if (c.payload) await table.put(c.payload);
      else continue;
      if (pending) await db.sync_outbox.delete(oid);
      touched.add(c.table);
    }
  });
  if ([...touched].some((t) => BALANCE_TABLES.has(t))) {
    await db.transaction('rw', db.accounts, db.transactions, db.transfers, async (tx) => {
      markRemote(tx);
      await recomputeBalances();
    });
  }
  if (touched.has('settings')) useSettings.getState().hydrate(await loadSettings());
  return touched;
}

async function pushPending(device: string): Promise<void> {
  for (let round = 0; round < 1000; round++) {
    const entries = await db.sync_outbox.orderBy('at').limit(PUSH_BATCH).toArray();
    if (!entries.length) return;
    const changes: SyncChange[] = [];
    const sent: OutboxEntry[] = [];
    let bytes = 0;
    for (const e of entries) {
      const row = (await db.table(e.table).get(e.key as string)) as Record<string, unknown> | undefined;
      const change: SyncChange = { table: e.table, key: JSON.stringify(e.key), updated_at: e.at, deleted: !row, payload: row ?? null };
      const size = JSON.stringify(change).length;
      if (sent.length && bytes + size > PUSH_BYTES) break;
      bytes += size;
      changes.push(change);
      sent.push(e);
    }
    const res = await api<PushResponse>('/sync/push', { method: 'POST', body: { device_id: device, changes } });
    // 移除已上傳的；上傳期間又被修改的（at 不同）保留到下一輪
    await db.transaction('rw', db.sync_outbox, async () => {
      for (const e of sent) {
        const cur = await db.sync_outbox.get(e.id);
        if (cur && cur.at === e.at) await db.sync_outbox.delete(e.id);
      }
    });
    if (res.rejected.length) await applyRemoteChanges(res.rejected);
  }
}

async function pullChanges(device: string): Promise<void> {
  let cursor = (await getMeta<number>(META_CURSOR)) ?? 0;
  for (let round = 0; round < 10_000; round++) {
    const res = await api<PullResponse>('/sync/pull', { query: { since: cursor, device_id: device, limit: 500 } });
    await applyRemoteChanges(res.changes);
    cursor = res.cursor;
    await setMeta(META_CURSOR, cursor);
    if (!res.has_more) return;
  }
}

async function runSync(): Promise<void> {
  const device = await deviceId();
  const status = await api<StatusResponse>('/sync/status');
  if (!status.enabled) { useSync.setState({ phase: 'off' }); return; }
  // 伺服器資料被清空或換了一台伺服器（游標倒退）→ 重新完整上傳、從頭下載
  const cursor = (await getMeta<number>(META_CURSOR)) ?? 0;
  if (status.cursor < cursor) {
    await setMeta(META_CURSOR, 0);
    await setMeta(META_INIT, false);
  }
  if (!(await getMeta<boolean>(META_INIT))) {
    await enqueueExistingData();
    await pullChanges(device);
  }
  await pushPending(device);
  await pullChanges(device);
}

let running: Promise<void> | null = null;
let again = false;
let started = false;

/** 立即同步（同時只會有一個同步在進行；進行中再呼叫會在結束後再跑一次） */
export function syncNow(): Promise<void> {
  if (running) { again = true; return running; }
  useSync.setState({ phase: 'syncing' });
  running = (async () => {
    try {
      do {
        again = false;
        await runSync();
      } while (again);
      useSync.setState({ phase: 'idle', lastSyncAt: Date.now(), error: '' });
    } catch (e) {
      const offline = !(e instanceof ApiError) || e.status === 0 || e.status >= 502;
      useSync.setState({ phase: offline ? 'offline' : 'error', error: (e as Error).message });
    } finally {
      running = null;
      useSync.setState({ pending: await db.sync_outbox.count().catch(() => 0) });
    }
  })();
  return running;
}

/** 登入後第一次同步：最多等 timeoutMs，逾時則在背景繼續（離線時直接略過） */
export async function initialSync(timeoutMs = 20_000): Promise<void> {
  await Promise.race([syncNow(), new Promise((r) => setTimeout(r, timeoutMs))]);
}

let debounce: ReturnType<typeof setTimeout> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
// 切回 App 時下載；切到背景時把剛記的帳先送出
const onVisible = () => void syncNow();
const onOnline = () => void syncNow();

/** 啟動背景同步排程 */
export function startSync(): void {
  if (started) return;
  started = true;
  setLocalChangeListener(() => {
    useSync.setState((s) => ({ pending: s.pending + 1 }));
    clearTimeout(debounce);
    debounce = setTimeout(() => void syncNow(), 1000);
  });
  // 畫面可見時每 15 秒、在背景時每 60 秒檢查其他裝置的變更
  let ticks = 0;
  interval = setInterval(() => {
    ticks++;
    if (document.visibilityState === 'visible' || ticks % 4 === 0) void syncNow();
  }, 15_000);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
}

export function stopSync(): void {
  started = false;
  setLocalChangeListener(null);
  clearTimeout(debounce);
  clearInterval(interval);
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('online', onOnline);
  useSync.setState({ phase: 'off' });
}

/** 登出前盡量把未上傳的變更送出（最多等 5 秒） */
export async function flushBeforeLogout(): Promise<void> {
  if (!started) return;
  await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 5000))]);
  stopSync();
}

export type { SyncedTable };

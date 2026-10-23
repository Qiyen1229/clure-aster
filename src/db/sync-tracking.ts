/**
 * 同步變更追蹤（Dexie DBCore 中介層）。
 *
 * 任何對「需同步資料表」的寫入（新增、修改、刪除、清空，包含 bulk 與 Collection.modify/delete）
 * 都會在同一個 IndexedDB 交易內寫一筆「待上傳」紀錄到 sync_outbox：
 *   { id: '表名|主鍵JSON', table, key, at: 變更時間 }
 * 同一筆資料多次修改只保留最後一次（put 覆蓋），上傳時再讀取當下內容；讀不到即代表已刪除。
 *
 * 套用伺服器下載的變更時，交易會被標記為「遠端」（markRemote），此時不寫 outbox，避免回傳造成循環。
 * 預設資料（內建分類等）以 markBaseline 標記，變更時間記為 0：伺服器上只要有任何版本都以伺服器為準，
 * 避免新裝置的預設值覆蓋使用者在其他裝置的修改。
 */
import Dexie, { type DBCore, type DBCoreMutateRequest, type DBCoreTable, type Middleware, type Transaction } from 'dexie';

export const OUTBOX = 'sync_outbox';

/** 需跨裝置同步的資料表（收據照片 attachments 體積大，暫不同步；報價快取等可重建的資料也不同步） */
export const SYNCED_TABLES = [
  'accounts', 'categories', 'transactions', 'transfers', 'templates', 'budgets', 'budget_periods', 'projects', 'tags',
  'saved_filters', 'recurring_rules', 'installments', 'people', 'debts', 'goals', 'exchange_rates', 'stocks',
  'stock_trades', 'dividends', 'watchlist', 'portfolio_snapshots', 'wishes', 'settings',
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];
const SYNCED = new Set<string>(SYNCED_TABLES);

/** 只屬於這台裝置的設定：App 鎖（PIN／Face ID）、通知權限、上次使用的帳戶、月曆收合狀態 */
export const DEVICE_ONLY_SETTINGS = new Set(['lock', 'notify', 'lastAccountId', 'calendarCollapsed']);

export interface OutboxEntry {
  id: string;
  table: SyncedTable;
  key: unknown;
  /** 變更時間（epoch ms）；伺服器以此做「最後寫入者勝」 */
  at: number;
}

export const outboxId = (table: string, key: unknown) => `${table}|${JSON.stringify(key)}`;

const remoteTrans = new WeakSet<object>();
const baselineTrans = new WeakSet<object>();
const coreTrans = (tx: Transaction) => (tx as unknown as { idbtrans: object }).idbtrans;

/** 把交易標記為「套用遠端變更」：其中的寫入不會進入待上傳佇列 */
export function markRemote(tx: Transaction): void {
  remoteTrans.add(coreTrans(tx));
}

/** 把交易標記為「預設資料」：仍會上傳，但優先順序最低（變更時間 0） */
export function markBaseline(tx: Transaction): void {
  baselineTrans.add(coreTrans(tx));
}

let listener: (() => void) | null = null;
/** 有本機變更時通知（同步引擎用來排程上傳） */
export function setLocalChangeListener(fn: (() => void) | null): void {
  listener = fn;
}

function keysOf(table: DBCoreTable, req: DBCoreMutateRequest, results: unknown[] | undefined): unknown[] {
  if (req.type === 'delete') return req.keys;
  if (req.type === 'deleteRange') return [];
  if (results?.length) return results;
  if (req.type === 'put' && req.updates) return req.updates.keys;
  if (req.keys?.length) return req.keys;
  const kp = table.schema.primaryKey.keyPath;
  if (!kp) return [];
  return req.values.map((v) => (Array.isArray(kp) ? kp.map((p) => Dexie.getByKeyPath(v, p)) : Dexie.getByKeyPath(v, kp)));
}

export const syncTracking: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'clure-sync-tracking',
  create(down) {
    return {
      ...down,
      transaction(stores, mode, options) {
        // 讀寫交易若包含需同步的表，自動把 outbox 加入交易範圍（確保變更與佇列同時成功或同時失敗）
        const s = mode === 'readwrite' && stores.some((n) => SYNCED.has(n)) && !stores.includes(OUTBOX) ? [...stores, OUTBOX] : stores;
        return down.transaction(s, mode, options);
      },
      table(name) {
        const table = down.table(name);
        if (!SYNCED.has(name)) return table;
        return {
          ...table,
          async mutate(req) {
            if (remoteTrans.has(req.trans)) return table.mutate(req);
            // 範圍刪除（table.clear()、Collection.delete()）事先查出主鍵
            let rangeKeys: unknown[] = [];
            if (req.type === 'deleteRange') {
              const r = await table.query({ trans: req.trans, values: false, query: { index: table.schema.primaryKey, range: req.range } });
              rangeKeys = r.result;
            }
            const res = await table.mutate(req);
            const keys = req.type === 'deleteRange' ? rangeKeys : keysOf(table, req, res.results);
            const at = baselineTrans.has(req.trans) ? 0 : Date.now();
            const entries: OutboxEntry[] = [];
            keys.forEach((key, i) => {
              if (key === undefined || key === null || res.failures?.[i]) return;
              if (name === 'settings' && DEVICE_ONLY_SETTINGS.has(String(key))) return;
              entries.push({ id: outboxId(name, key), table: name as SyncedTable, key, at });
            });
            if (entries.length) {
              await down.table(OUTBOX).mutate({ type: 'put', trans: req.trans, values: entries });
              const fn = listener;
              if (fn) setTimeout(fn, 0);
            }
            return res;
          },
        };
      },
    };
  },
};

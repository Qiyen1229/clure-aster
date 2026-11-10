/**
 * 本機輕量錯誤日誌：
 * 全域攔截 window.onerror 與 window.onunhandledrejection，將非同步錯誤寫入 IndexedDB `errors` 表。
 * 本地最多保存 50 筆，並可在設定頁「系統資訊／關於」匯出最近 20 筆 JSON 診斷檔，無任何外部第三方追蹤依賴。
 */
import { db } from '@/db/schema';
import type { AppErrorLog } from '@/db/types';
import { saveFile } from './backup';

export const MAX_ERROR_LOGS = 50;

/**
 * 寫入一筆本機錯誤日誌，並限制資料表最多保留 MAX_ERROR_LOGS 筆
 */
export async function logAppError(entry: Omit<AppErrorLog, 'id'>): Promise<void> {
  try {
    await db.errors.add(entry as AppErrorLog);
    const count = await db.errors.count();
    if (count > MAX_ERROR_LOGS) {
      const excess = count - MAX_ERROR_LOGS;
      const oldestKeys = await db.errors.orderBy('id').limit(excess).primaryKeys();
      if (oldestKeys.length) {
        await db.errors.bulkDelete(oldestKeys);
      }
    }
  } catch {
    // 錯誤日誌寫入絕不拋出例外，避免引發連鎖錯誤
  }
}

/**
 * 取得最近的錯誤日誌（最新在最前）
 */
export async function getRecentErrors(limit = 20): Promise<AppErrorLog[]> {
  try {
    return await db.errors.orderBy('ts').reverse().limit(limit).toArray();
  } catch {
    return [];
  }
}

/**
 * 匯出錯誤日誌 JSON 字串，包含系統診斷資訊
 */
export async function exportErrorLogs(limit = 20): Promise<string> {
  const logs = await getRecentErrors(limit);
  const payload = {
    app: 'aster',
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown',
    exportedAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    count: logs.length,
    errors: logs,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * 觸發下載或分享錯誤日誌診斷檔案
 */
export async function exportErrorLogsToFile(limit = 20): Promise<'saved' | 'shared' | 'downloaded' | 'cancelled'> {
  const json = await exportErrorLogs(limit);
  const blob = new Blob([json], { type: 'application/json' });
  const filename = `aster-error-logs-${new Date().toISOString().slice(0, 10)}.json`;
  return saveFile(blob, filename, 'application/json');
}

let installed = false;

/**
 * 註冊全域 onerror 與 onunhandledrejection 監聽器
 */
export function initGlobalErrorLogging(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    // 忽略 Vite 動態模組載入錯誤（已有專屬重載處理）或無訊息事件
    if (!event.message || event.message.includes('ResizeObserver')) return;
    const err = event.error;
    void logAppError({
      ts: Date.now(),
      type: 'error',
      message: String(event.message || err?.message || 'Unknown error'),
      stack: typeof err?.stack === 'string' ? err.stack : undefined,
      url: typeof event.filename === 'string' ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Unhandled Promise Rejection';
    const stack = reason instanceof Error ? reason.stack : undefined;
    void logAppError({
      ts: Date.now(),
      type: 'unhandledrejection',
      message: String(message),
      stack: typeof stack === 'string' ? stack : undefined,
    });
  });
}

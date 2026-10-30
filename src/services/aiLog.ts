/**
 * 「AI 送出紀錄」：每次真的把內容送去 AI 時，在這台裝置記下「送了什麼」，讓使用者能親眼檢查。
 * - 只記在本機 meta 表（不同步、不上傳），最多 25 筆，單筆內容最多 20,000 字元
 * - 快取命中、沒有真的送出的不會記
 * - 照片只記大小，不留存影像
 */
import { db } from '@/db/schema';

export interface AiSendRecord {
  at: number;
  path: string;
  /** 送出的 JSON（照片已換成說明文字） */
  payload: string;
  bytes: number;
  truncated: boolean;
}

const KEY = 'ai-sent-log';
const MAX_RECORDS = 25;
const MAX_CHARS = 20_000;

export const AI_FEATURE_LABEL: Record<string, string> = {
  '/ai/parse-entry': '一句話記帳（規則看不懂時）', '/ai/ask': '問 AI', '/ai/budget-plan': '下月預算建議', '/ai/insights': '白話解讀', '/ai/categorize': '整理「其他」分類',
  '/ai/receipt': '拍照記帳', '/ai/search-plan': '用 AI 找', '/ai/explain': '專案／帳戶解說',
};

/** 把 data:image/... 換成「[照片約 NKB]」，其餘原樣 */
export function redactForLog(body: unknown): string {
  return JSON.stringify(body, (_k, v) => (typeof v === 'string' && v.startsWith('data:image') ? `[照片，約 ${Math.round((v.length * 3) / 4 / 1024)} KB，不留存]` : v), 2) ?? '';
}

export async function recordAiSend(path: string, body: unknown): Promise<void> {
  try {
    const full = redactForLog(body);
    const rec: AiSendRecord = { at: Date.now(), path, payload: full.slice(0, MAX_CHARS), bytes: new Blob([full]).size, truncated: full.length > MAX_CHARS };
    const old = ((await db.meta.get(KEY))?.value as AiSendRecord[] | undefined) ?? [];
    await db.meta.put({ key: KEY, value: [rec, ...old].slice(0, MAX_RECORDS) });
  } catch { /* 記錄失敗不影響功能 */ }
}

export async function loadAiLog(): Promise<AiSendRecord[]> {
  return ((await db.meta.get(KEY).catch(() => undefined))?.value as AiSendRecord[] | undefined) ?? [];
}

export const clearAiLog = () => db.meta.delete(KEY);

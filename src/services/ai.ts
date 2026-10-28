/**
 * AI 輔助解析（選用）：一句話記帳規則看不懂時的後備。
 * - 預設關閉，使用者在「設定 → AI 輔助」手動開啟；只有明確送出（按下記帳／說完）才會呼叫，輸入中的即時預覽不會用到額度。
 * - 只送使用者輸入的那一句話與分類／帳戶「名稱」，不送帳目紀錄與餘額；伺服器端有每日／每週／每月額度。
 * - 端對端加密不涵蓋這個功能：內容會經過你的伺服器與 AI 供應商。
 */
import { aiEntriesToDrafts, namesForAi, type AiEntry } from '@/domain/aiparse';
import type { DraftEntry } from '@/domain/nlp';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { api } from './api';
import { parseContext } from './quickentry';

export interface AiQuotaWindow { limit: number; used: number; remaining: number | null; resets_at: string }
export interface AiQuota { daily: AiQuotaWindow; weekly: AiQuotaWindow; monthly: AiQuotaWindow }
export interface AiStatus { enabled: boolean; configured: boolean; available: boolean; message: string; quota: AiQuota }

export const aiEnabledLocally = () => AUTH_ENABLED && !!useSettings.getState().ai?.enabled && navigator.onLine;

export const getAiStatus = () => api<AiStatus>('/ai/status');

/**
 * 呼叫伺服器解析一句話；失敗（額度用完、供應商掛了、看不懂）會丟出帶中文訊息的錯誤。
 * 同一句話進行中、或 5 秒內剛解析過，直接共用結果，不會重複送出（連點、重複觸發都不會多扣額度）。
 */
const recent = new Map<string, Promise<{ drafts: DraftEntry[]; quota: AiQuota }>>();
export function aiParse(text: string) {
  const key = text.trim();
  const hit = recent.get(key);
  if (hit) return hit;
  const p = aiParseOnce(key);
  recent.set(key, p);
  const drop = () => setTimeout(() => recent.delete(key), 5000);
  p.then(drop, () => recent.delete(key)); // 失敗不保留，讓使用者可以立刻重試
  return p;
}

async function aiParseOnce(text: string): Promise<{ drafts: DraftEntry[]; quota: AiQuota }> {
  const ctx = await parseContext();
  const names = namesForAi({ today: ctx.today, accounts: ctx.accounts, categories: ctx.categories });
  const res = await api<{ entries: AiEntry[]; quota: AiQuota }>('/ai/parse-entry', { method: 'POST', body: { text, ...names, today: ctx.today } });
  return { drafts: aiEntriesToDrafts(res.entries, ctx, text), quota: res.quota };
}

/** "剩 N 次" 的簡短說明（取最緊的那一層） */
export function quotaLabel(q: AiQuota): string {
  const rem = [q.daily, q.weekly, q.monthly].filter((w) => w.remaining !== null).map((w) => w.remaining as number);
  return rem.length ? `AI 額度剩 ${Math.min(...rem)} 次` : 'AI 額度不限';
}

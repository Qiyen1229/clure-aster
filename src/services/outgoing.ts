/**
 * 對外通知（Discord／Telegram／LINE／自訂 Webhook）的用戶端。
 * 伺服器負責發送（機密加密存在伺服器）；App 負責「偵測到什麼事」：
 *   - 每一則 App 內通知（異常大額、預算預警、發票中獎…）在建立的同時轉送給伺服器
 *   - 排程提醒（週報、月報、繳款、訂閱…）由 services/push.ts 排給伺服器，到點同時發到網頁推播與這些通道
 * 啟用端對端加密且關閉「訊息包含金額與名稱」時，只送通用標題，不送內容。
 */
import { db } from '@/db/schema';
import type { Reminder } from '@/db/types';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { api } from './api';
import { useSync } from './sync';

export type ChannelKind = 'discord' | 'telegram' | 'line' | 'webhook';
export type OutEvent = 'anomaly' | 'budget' | 'weekly' | 'monthly' | 'reminder' | 'daily' | 'prize';

export interface Channel {
  id: number;
  kind: ChannelKind;
  name: string;
  hint: string;
  events: OutEvent[];
  enabled: boolean;
  last_ok_at: string | null;
  last_error: string;
}

export const KIND_INFO: Record<ChannelKind, { label: string; icon: string }> = {
  discord: { label: 'Discord', icon: '💬' },
  telegram: { label: 'Telegram', icon: '✈️' },
  line: { label: 'LINE', icon: '🟢' },
  webhook: { label: '自訂 Webhook', icon: '🔗' },
};

export const EVENT_INFO: Record<OutEvent, { label: string; sub: string }> = {
  anomaly: { label: '異常與漲價', sub: '異常大額、訂閱漲價' },
  budget: { label: '預算', sub: '預算預警、超支' },
  weekly: { label: '週報', sub: '每週摘要出爐' },
  monthly: { label: '月報', sub: '每月摘要出爐' },
  prize: { label: '發票中獎', sub: '統一發票對中獎' },
  reminder: { label: '提醒', sub: '信用卡繳款、訂閱續約、心願、備份、到價' },
  daily: { label: '每日記帳', sub: '今天還沒記帳的提醒（較頻繁）' },
};
export const DEFAULT_EVENTS: OutEvent[] = ['anomaly', 'budget', 'weekly', 'monthly', 'prize'];

export const listChannels = async (): Promise<Channel[]> => {
  const list = await api<Channel[]>('/notify/channels');
  void db.meta.put({ key: 'outgoingActive', value: list.some((c) => c.enabled) });
  return list;
};
export const createChannel = (body: { kind: ChannelKind; name: string; config: Record<string, string>; events: OutEvent[] }) => api<Channel>('/notify/channels', { method: 'POST', body });
export const patchChannel = (id: number, body: Partial<{ name: string; enabled: boolean; events: OutEvent[]; config: Record<string, string> }>) => api<Channel>(`/notify/channels/${id}`, { method: 'PATCH', body });
export const deleteChannel = (id: number) => api<{ message: string }>(`/notify/channels/${id}`, { method: 'DELETE' });
export const testChannel = (id: number) => api<{ ok: boolean; detail: string }>(`/notify/channels/${id}/test`, { method: 'POST' });

/** 有沒有任何已開啟的通道（本機快取，避免每則通知都問伺服器；開啟 App 與管理通道時更新） */
export async function hasActiveChannels(): Promise<boolean> {
  if (!AUTH_ENABLED) return false;
  return !!(await db.meta.get('outgoingActive'))?.value;
}
export async function refreshOutgoingActive(): Promise<boolean> {
  if (!AUTH_ENABLED) return false;
  try { return (await listChannels()).some((c) => c.enabled); } catch { return hasActiveChannels(); }
}

/** App 內通知的種類 → 對外通知的類型 */
const KIND_EVENT: Record<Reminder['kind'], OutEvent> = {
  budget: 'budget', insight: 'anomaly', invoice: 'prize', daily_log: 'daily',
  card_due: 'reminder', subscription: 'reminder', price_alert: 'reminder', backup: 'reminder', sync: 'reminder',
};
const GENERIC_TITLE: Record<OutEvent, string> = {
  anomaly: '偵測到需要留意的支出', budget: '預算提醒', weekly: '週報出爐', monthly: '月報出爐', reminder: '提醒', daily: '今天還沒記帳', prize: '統一發票中獎了',
};
const LEVEL: Partial<Record<OutEvent, 'warn' | 'alert' | 'success'>> = { anomaly: 'warn', budget: 'warn', prize: 'success' };

/** 把一則 App 內通知轉送到對外通道；任何失敗都安靜略過（不能影響記帳與原本的通知） */
export async function emitFromReminder(kind: Reminder['kind'], title: string, body: string, path: string, key: string): Promise<void> {
  try {
    if (!(await hasActiveChannels())) return;
    const event = KIND_EVENT[kind] ?? 'reminder';
    const priv = !!useSync.getState().e2ee?.enabled && !useSettings.getState().outgoingDetail;
    await api('/notify/event', {
      method: 'POST',
      body: { event, title: priv ? GENERIC_TITLE[event] : title, body: priv ? '點開 Aster 查看詳情' : body, level: LEVEL[event] ?? 'info', path, key },
    });
  } catch { /* 伺服器暫時連不上或限流：略過 */ }
}

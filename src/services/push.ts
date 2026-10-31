/**
 * 背景推播（Web Push）：App 關閉時也能收到提醒。
 *
 * 伺服器不知道你的帳目內容（可能已端對端加密），因此由 App 在每次開啟時算好「接下來 14 天」的提醒時間
 * （每日記帳、信用卡繳款、訂閱續約、心願冷靜期、備份、週報／月報），整批交給伺服器排程；伺服器到點只負責送出。
 * 啟用端對端加密時，推播文字不含金額與名稱。
 * 限制：iPhone 需 iOS 16.4 以上、加入主畫面，且網站需 HTTPS；到價提醒需要即時報價，仍只在 App 開啟時檢查。
 */
import { db } from '@/db/schema';
import { creditCardStatement } from '@/db/repo/accounts';
import { addDays, todayKey } from '@/domain/period';
import { formatMoney } from '@/domain/money';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { api } from './api';
import { deviceId, useSync } from './sync';
import { notificationSupport, requestPermission } from './notifications';

export interface PushItem { id: string; at: number; title: string; body: string; url: string }

export function pushSupported(): boolean {
  return AUTH_ENABLED && 'serviceWorker' in navigator && 'PushManager' in window && notificationSupport() !== 'needs-install' && notificationSupport() !== 'unsupported';
}

const fromB64Url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const toB64Url = (b: ArrayBuffer | null) => (b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '');

export interface PushStatus { public_key: string; subscribed: boolean; scheduled: number; devices: number; last_error: string }

export const fetchPushStatus = async (): Promise<PushStatus> => api<PushStatus>('/push/status', { query: { device_id: await deviceId() } });

/**
 * 確認這台裝置在瀏覽器與伺服器兩邊都有有效訂閱，缺的就補上。
 * 設定（含「背景推播」開關）會跟著帳號同步，但訂閱是每台裝置各自的；伺服器收到 410 也會刪掉訂閱。
 * 只要有任何一邊遺失，開關看起來是開的卻永遠收不到通知——所以每次開啟 App 都檢查。
 */
export async function ensurePushSubscription(): Promise<boolean> {
  if (!pushSupported() || notificationSupport() !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  const device = await deviceId();
  const st = await api<PushStatus>('/push/status', { query: { device_id: device } });
  let sub = await reg.pushManager.getSubscription();
  // 伺服器換過 VAPID 金鑰（例如重建資料夾）時，舊訂閱要先取消
  const same = sub?.options.applicationServerKey && toB64Url(sub.options.applicationServerKey) === st.public_key;
  if (sub && !same) { await sub.unsubscribe().catch(() => undefined); sub = null; }
  if (sub && st.subscribed) return true;
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64Url(st.public_key) });
  await api('/push/subscribe', { method: 'POST', body: { device_id: device, endpoint: sub.endpoint, keys: { p256dh: toB64Url(sub.getKey('p256dh')), auth: toB64Url(sub.getKey('auth')) } } });
  return true;
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('這個瀏覽器不支援背景推播（iPhone 需 iOS 16.4 以上並加入主畫面）');
  if ((await requestPermission()) !== 'granted') throw new Error('請先允許通知');
  await ensurePushSubscription();
  const s = useSettings.getState();
  s.set('notify', { ...s.notify, enabled: true, push: true });
  await schedulePush();
}

export async function disablePush(): Promise<void> {
  const s = useSettings.getState();
  s.set('notify', { ...s.notify, push: false });
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => undefined);
      await sub.unsubscribe();
    }
    await api('/push/schedule', { method: 'POST', body: { device_id: await deviceId(), items: [] } }).catch(() => undefined);
  } catch { /* 已取消 */ }
}

export async function sendTestPush(): Promise<string> {
  const r = await api<{ message: string }>('/push/test', { method: 'POST' });
  return r.message;
}

const at = (date: string, time: string) => new Date(`${date}T${time}:00`).getTime();

/** 算出接下來 days 天的提醒（純資料，方便測試） */
export async function upcomingPushItems(days = 14, now = Date.now()): Promise<PushItem[]> {
  const s = useSettings.getState();
  const cfg = s.notify;
  const priv = !!useSync.getState().e2ee?.enabled;
  const today = todayKey();
  const items: PushItem[] = [];
  const add = (it: PushItem) => { if (it.at > now && it.at <= now + days * 86400_000) items.push(it); };

  if (cfg.daily) {
    const loggedToday = (await db.transactions.where('date').equals(today).filter((t) => !t.deletedAt).count()) > 0;
    for (let i = loggedToday ? 1 : 0; i < days; i++) {
      const d = addDays(today, i);
      add({ id: `daily:${d}`, at: at(d, cfg.dailyTime), title: '今天還沒記帳喔 ✍️', body: '花 10 秒記下今天的花費吧', url: '/add' });
    }
  }
  if (cfg.cardDue) {
    for (const acc of await db.accounts.where('type').equals('credit').toArray()) {
      if (acc.archived || !acc.credit) continue;
      const st = await creditCardStatement(acc);
      if (!st || st.statementMinor <= 0) continue;
      const d = addDays(st.cycle.dueDate, -cfg.cardDueDays);
      add({
        id: `card:${acc.id}:${st.cycle.dueDate}`, at: at(d < today ? today : d, '09:00'), title: priv ? '💳 信用卡繳款提醒' : `💳 ${acc.name} 繳款提醒`,
        body: priv ? `繳款截止日 ${st.cycle.dueDate}` : `本期應繳 ${formatMoney(st.statementMinor, acc.currency)}，截止日 ${st.cycle.dueDate}`, url: `/accounts/${acc.id}`,
      });
    }
  }
  if (cfg.subscription) {
    for (const r of await db.recurring_rules.where('active').equals(1).toArray()) {
      if (r.kind !== 'subscription') continue;
      const d = addDays(r.nextDue, -r.remindDaysBefore);
      add({
        id: `sub:${r.id}:${r.nextDue}`, at: at(d, '09:00'), title: priv ? '📅 訂閱即將續約' : `📅 ${r.name} 即將續約`,
        body: priv ? `${r.nextDue} 將扣款` : `${r.nextDue} 將扣款 ${formatMoney(r.template.amountMinor ?? 0, r.template.currency ?? s.baseCurrency)}`, url: '/plan?tab=recurring',
      });
    }
  }
  for (const w of await db.wishes.where('decideAt').belowOrEqual(addDays(today, days)).toArray()) {
    if (w.status !== 'waiting') continue;
    add({ id: `wish:${w.id}:${w.decideAt}`, at: at(w.decideAt, '09:00'), title: priv ? '🧊 心願冷靜期結束' : `🧊 你還想買「${w.name}」嗎？`, body: '冷靜期結束了，決定買或放棄吧！', url: '/plan?tab=wish' });
  }
  // 週報／月報：伺服器只負責送出，內容不含金額（推播排好時那一週還沒結束）；點開後在 App 內看完整摘要
  if (cfg.weekly || cfg.monthly) {
    const { periodStartsWithin } = await import('./summary');
    if (cfg.weekly) {
      for (const d of periodStartsWithin('week', today, days)) {
        add({ id: `weekly:${d}`, at: at(d, '09:00'), title: '📊 上週摘要出爐', body: '花了多少、和前一週比、哪一類變多了？點開看看', url: '/reports/summary?unit=week' });
      }
    }
    if (cfg.monthly) {
      for (const d of periodStartsWithin('month', today, days)) {
        add({ id: `monthly:${d}`, at: at(d, '09:00'), title: '📅 上個月的月報出爐', body: '收支、儲蓄率、分類變化一次看', url: '/reports/summary?unit=month' });
      }
    }
  }
  if (cfg.backup) {
    const last = (await db.meta.get('lastBackupAt'))?.value as number | undefined;
    if (last) {
      const due = last + cfg.backupDays * 86400_000;
      const d = new Date(Math.max(due, now + 60_000));
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      add({ id: `backup:${key}`, at: Math.max(at(key, '20:00'), now + 60_000), title: '💾 該備份囉', body: `距離上次備份已 ${cfg.backupDays} 天`, url: '/settings/backup' });
    }
  }
  return items.sort((a, b) => a.at - b.at).slice(0, 200);
}

/** 把接下來 14 天的提醒交給伺服器排程（開啟 App、變更提醒設定時呼叫） */
export async function schedulePush(): Promise<number> {
  const s = useSettings.getState();
  // 網頁推播或對外通道（Discord／Telegram／LINE）任一個開著就要排程：到點由伺服器同時送出
  const external = await import('./outgoing').then((m) => m.hasActiveChannels());
  if (!AUTH_ENABLED || (!s.notify.push && !external)) return 0;
  if (s.notify.push) await ensurePushSubscription().catch(() => undefined); // 訂閱遺失時自動補上；補不上也照樣排程
  const items = await upcomingPushItems();
  await api('/push/schedule', { method: 'POST', body: { device_id: await deviceId(), items } });
  return items.length;
}

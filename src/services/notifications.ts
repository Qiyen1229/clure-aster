/**
 * 提醒與通知。
 * 提醒在「開啟 App 時」與「App 在前景時」檢查，並透過 Service Worker 的 showNotification 顯示系統通知
 * （iOS 16.4+ 需先「加入主畫面」並允許通知）。不支援或未授權時，提醒會顯示在 App 內的提醒中心（鈴鐺）。
 * 啟用帳號系統時，另可開啟背景推播（services/push.ts）：由自架伺服器在 App 關閉時送出預先排好的提醒。
 */
import { db } from '@/db/schema';
import type { Reminder } from '@/db/types';
import { useSettings } from '@/stores/settings';
import { computeBudgets } from '@/db/repo/plan';
import { creditCardStatement } from '@/db/repo/accounts';
import { addDays, todayKey } from '@/domain/period';
import { formatMoney } from '@/domain/money';

export type NotifyKind = Reminder['kind'];

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}
export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export type PermissionState = 'granted' | 'denied' | 'default' | 'unsupported' | 'needs-install';

export function notificationSupport(): PermissionState {
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'unsupported';
  return Notification.permission as PermissionState;
}

export async function requestPermission(): Promise<PermissionState> {
  const s = notificationSupport();
  if (s === 'needs-install' || s === 'unsupported') return s;
  const r = await Notification.requestPermission();
  return r as PermissionState;
}

/** 顯示通知（系統通知 + 寫入提醒中心）；同一個 id 只會通知一次 */
export async function notify(title: string, body: string, url = '/', kind: NotifyKind = 'daily_log', dedupeId?: string) {
  const id = dedupeId ?? `${kind}:${title}:${todayKey()}`;
  if (await db.reminders.get(id)) return;
  const row: Reminder = { id, kind, refId: url, dueAt: Date.now(), done: 0, notifiedAt: Date.now(), title, body };
  await db.reminders.put(row);
  const { notify: cfg } = useSettings.getState();
  if (!cfg.enabled || notificationSupport() !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/favicon-32.png', tag: id, data: { url } });
  } catch {
    try { new Notification(title, { body, icon: '/icons/icon-192.png' }); } catch { /* 忽略 */ }
  }
}

/** 開啟 App／回到前景時檢查所有提醒條件 */
export async function runReminderChecks(now = new Date()) {
  const s = useSettings.getState();
  const cfg = s.notify;
  const today = todayKey();

  // 每日記帳提醒：超過設定時間且今天尚未記帳
  if (cfg.daily) {
    const [h, m] = cfg.dailyTime.split(':').map(Number);
    if (now.getHours() * 60 + now.getMinutes() >= h * 60 + m) {
      const count = await db.transactions.where('date').equals(today).filter((t) => !t.deletedAt).count();
      if (count === 0) await notify('今天還沒記帳喔 ✍️', '花 10 秒記下今天的花費吧', '/add', 'daily_log', `daily:${today}`);
    }
  }

  // 信用卡繳款提醒
  if (cfg.cardDue) {
    for (const acc of await db.accounts.where('type').equals('credit').toArray()) {
      if (acc.archived || !acc.credit) continue;
      const st = await creditCardStatement(acc);
      if (!st || st.statementMinor <= 0) continue;
      if (st.cycle.dueDate >= today && st.cycle.dueDate <= addDays(today, cfg.cardDueDays)) {
        await notify(`💳 ${acc.name} 繳款提醒`, `本期應繳 ${formatMoney(st.statementMinor, acc.currency)}，截止日 ${st.cycle.dueDate}`,
          `/accounts/${acc.id}`, 'card_due', `card:${acc.id}:${st.cycle.dueDate}`);
      }
    }
  }

  // 預算警示
  if (cfg.budget) {
    for (const v of await computeBudgets(today)) {
      if (v.status.level === 'ok') continue;
      const over = v.status.level === 'over';
      await notify(over ? `⚠️ 「${v.budget.name}」已超支` : `「${v.budget.name}」已用 ${Math.round(v.status.pct)}%`,
        `本期剩餘 ${formatMoney(v.status.remaining, v.budget.currency)}`, '/plan?tab=budget', 'budget', `budget:${v.budget.id}:${v.period.start}:${v.status.level}`);
    }
  }

  // 訂閱續約與週期待確認
  if (cfg.subscription) {
    for (const r of await db.recurring_rules.where('active').equals(1).toArray()) {
      if (r.pendingDates.length) {
        await notify(`🔁 ${r.name} 待確認`, `有 ${r.pendingDates.length} 筆週期帳目等待確認入帳`, '/plan?tab=recurring', 'subscription', `pending:${r.id}:${r.pendingDates.join(',')}`);
      }
      if (r.kind === 'subscription' && r.nextDue >= today && r.nextDue <= addDays(today, r.remindDaysBefore)) {
        await notify(`📅 ${r.name} 即將續約`, `${r.nextDue} 將扣款 ${formatMoney(r.template.amountMinor ?? 0, r.template.currency ?? s.baseCurrency)}`,
          '/plan?tab=recurring', 'subscription', `sub:${r.id}:${r.nextDue}`);
      }
    }
  }

  // 心願清單：冷靜期結束（或明天結束）提醒
  for (const w of await db.wishes.where('decideAt').belowOrEqual(addDays(today, 1)).toArray()) {
    if (w.status !== 'waiting') continue;
    await notify(`🧊 你還想買「${w.name}」嗎？`, `冷靜期${w.decideAt <= today ? '已結束' : '明天結束'}，${formatMoney(w.priceMinor, w.currency)}。決定買或放棄吧！`,
      '/plan?tab=wish', 'subscription', `wish:${w.id}:${w.decideAt}`);
  }

  // 備份提醒
  if (cfg.backup) {
    const last = (await db.meta.get('lastBackupAt'))?.value as number | undefined;
    const txCount = await db.transactions.count();
    if (txCount > 20 && (!last || Date.now() - last > cfg.backupDays * 86400000)) {
      await notify('💾 該備份囉', last ? `距離上次備份已 ${Math.floor((Date.now() - last) / 86400000)} 天` : '你還沒有備份過資料', '/settings/backup', 'backup', `backup:${today.slice(0, 7)}:${Math.floor(new Date().getDate() / cfg.backupDays)}`);
    }
  }
}

export async function markAllRead() {
  await db.reminders.where('done').equals(0).modify({ done: 1 });
}

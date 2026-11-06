/**
 * 提醒中心（鈴鐺）：所有財務提醒的唯一入口——帳單到期、預算警示、訂閱續約、到價／除息、異常偵測（系統通知不可用時這裡是主要管道），點擊前往相關頁面。
 * 最上面是「需要你看一下」（收件匣待確認、已超支、除息、異常偵測、AI 上週重點），首頁不再放提醒。
 */
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { AttentionCard } from './AttentionCard';
import { clearAllReminders, markAllRead, notificationSupport, runReminderChecks } from '@/services/notifications';
import { Sheet } from '@/ui/Sheet';
import { EmptyState } from '@/ui/controls';

const ICON: Record<string, string> = { daily_log: '✍️', card_due: '💳', budget: '🎯', subscription: '🔁', price_alert: '📈', backup: '💾', sync: '☁️', insight: '💡' };

export function useUnreadCount() {
  return useLiveQuery(() => db.reminders.where('done').equals(0).count(), []) ?? 0;
}

export function RemindersSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const list = useLiveQuery(() => db.reminders.orderBy('dueAt').reverse().filter((r) => !r.cleared).limit(60).toArray(), []) ?? [];
  const support = notificationSupport();
  return (
    <Sheet open={open} onClose={() => { void markAllRead(); onClose(); }} title="提醒"
      right={(
        <span style={{ display: 'flex', gap: 4 }}>
          {list.length > 0 && <button className="accent" style={{ minHeight: 44 }} onClick={() => void clearAllReminders()}>清除通知</button>}
          <button className="accent" style={{ minHeight: 44 }} onClick={() => void runReminderChecks()}>重新檢查</button>
        </span>
      )}>
      {/* 各區塊（系統通知提示、需要你看一下、提醒清單）之間固定留間距，不再黏在一起 */}
      <div className="rem-stack">
      {support !== 'granted' && (
        <button className="card" style={{ width: '100%', textAlign: 'left' }} onClick={() => { onClose(); navigate('/settings/notifications'); }}>
          🔔 {support === 'needs-install' ? '把 App 加入主畫面後即可開啟系統通知（iOS 16.4+）' : support === 'unsupported' ? '此瀏覽器不支援系統通知，提醒會顯示在這裡' : '開啟系統通知，帳單與預算提醒不漏接 →'}
        </button>
      )}
      <AttentionCard onGo={onClose} />
      {list.length === 0 ? <EmptyState emoji="🔕" title="目前沒有提醒" text="帳單到期、預算警示、訂閱續約、到價提醒都會出現在這裡。" /> : (
        <div className="list">
          {list.map((r) => (
            <button key={r.id} className="row" onClick={() => { void db.reminders.update(r.id, { done: 1 }); onClose(); if (r.refId.startsWith('/')) navigate(r.refId); }}>
              <span aria-hidden="true" style={{ fontSize: 22 }}>{ICON[r.kind] ?? '🔔'}</span>
              <div className="row-main">
                <div className="row-title" style={{ fontWeight: r.done ? 400 : 600 }}>{r.title}</div>
                <div className="row-sub" style={{ whiteSpace: 'normal' }}>{r.body}</div>
              </div>
              <span className="row-sub">{new Date(r.dueAt).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })}</span>
            </button>
          ))}
        </div>
      )}
      </div>
    </Sheet>
  );
}

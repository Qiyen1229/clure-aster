/**
 * 提醒中心（鈴鐺）：所有財務提醒的唯一入口——帳單到期、預算警示、訂閱續約、到價／除息、異常偵測（系統通知不可用時這裡是主要管道），點擊前往相關頁面。
 * 最上面是「需要你看一下」（收件匣待確認、已超支、除息、異常偵測、AI 上週重點），首頁不再放提醒。
 */
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { AttentionCard } from './AttentionCard';
import { clearAllReminders, clearReminder, markAllRead, notificationSupport, runReminderChecks } from '@/services/notifications';
import { Sheet } from '@/ui/Sheet';
import { EmptyState } from '@/ui/controls';
import { SwipeRow } from '@/ui/SwipeRow';
import { Icon } from '@/ui/Icon';

const ICON: Record<string, string> = { daily_log: '✍️', card_due: '💳', budget: '🎯', subscription: '🔁', price_alert: '📈', backup: '💾', sync: '☁️', insight: '💡' };

export function useUnreadCount() {
  return useLiveQuery(() => db.reminders.where('done').equals(0).count(), []) ?? 0;
}

export function RemindersSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const list = useLiveQuery(() => db.reminders.orderBy('dueAt').reverse().filter((r) => !r.cleared).limit(60).toArray(), []) ?? [];
  const support = notificationSupport();
  // 重新檢查：按下去立刻有回饋（轉圈 → 打勾，並說明找到幾則新的），不然看不出有沒有按到
  const [check, setCheck] = useState<{ phase: 'idle' | 'busy' | 'done'; found: number }>({ phase: 'idle', found: 0 });
  const timer = useRef<number>();
  const recheck = async () => {
    if (check.phase === 'busy') return;
    window.clearTimeout(timer.current);
    setCheck({ phase: 'busy', found: 0 });
    navigator.vibrate?.(8);
    const before = await db.reminders.count();
    await Promise.all([runReminderChecks().catch(() => undefined), new Promise((r) => setTimeout(r, 700))]);
    const found = Math.max(0, (await db.reminders.count()) - before);
    setCheck({ phase: 'done', found });
    timer.current = window.setTimeout(() => setCheck({ phase: 'idle', found: 0 }), 2200);
  };
  return (
    <Sheet open={open} onClose={() => { void markAllRead(); onClose(); }} title="提醒"
      right={(
        <span style={{ display: 'flex', gap: 4 }}>
          {list.length > 0 && <button className="accent" style={{ minHeight: 44 }} onClick={() => void clearAllReminders()}>清除通知</button>}
          <button className={`accent recheck ${check.phase}`} style={{ minHeight: 44 }} disabled={check.phase === 'busy'} aria-live="polite" onClick={() => void recheck()}>
            {check.phase === 'idle' ? <Icon name="repeat" /> : check.phase === 'busy' ? <Icon name="repeat" className="spin" /> : <Icon name="check" className="recheck-ok" />}
            {check.phase === 'idle' ? '重新檢查' : check.phase === 'busy' ? '檢查中…' : check.found ? `新增 ${check.found} 則` : '沒有新提醒'}
          </button>
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
          {list.map((r, i) => (
            <SwipeRow key={r.id} flat onDelete={() => void clearReminder(r.id)}
              onTap={() => { void db.reminders.update(r.id, { done: 1 }); onClose(); if (r.refId.startsWith('/')) navigate(r.refId); }}>
              <div className={i ? 'row row-sep' : 'row'}>
                <span aria-hidden="true" style={{ fontSize: 22 }}>{ICON[r.kind] ?? '🔔'}</span>
                <div className="row-main">
                  <div className="row-title" style={{ fontWeight: r.done ? 400 : 600 }}>{r.title}</div>
                  <div className="row-sub" style={{ whiteSpace: 'normal' }}>{r.body}</div>
                </div>
                <span className="row-sub">{new Date(r.dueAt).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })}</span>
              </div>
            </SwipeRow>
          ))}
        </div>
      )}
      </div>
    </Sheet>
  );
}

/**
 * 通知設定：權限引導（iOS 需先加入主畫面、iOS 16.4+）、各類提醒開關、每日提醒時間、測試通知。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isIOS, notificationSupport, notify, requestPermission, runReminderChecks, type PermissionState } from '@/services/notifications';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import type { NotifySettings } from '@/db/repo/settings';

const STATE_TEXT: Record<PermissionState, string> = {
  granted: '已允許系統通知 ✓',
  denied: '通知已被封鎖。請到 iPhone「設定 → 通知 → Clure」或瀏覽器網站設定中允許。',
  default: '尚未允許系統通知',
  unsupported: '此瀏覽器不支援系統通知，提醒會顯示在 App 內的提醒中心（鈴鐺）。',
  'needs-install': 'iPhone 需先「加入主畫面」並從主畫面開啟（iOS 16.4 以上），才能使用系統通知。目前提醒會顯示在 App 內的提醒中心。',
};

export default function NotificationsPage() {
  const navigate = useNavigate();
  const s = useSettings();
  const n = s.notify;
  const set = (patch: Partial<NotifySettings>) => s.set('notify', { ...n, ...patch });
  const [perm, setPerm] = useState<PermissionState>(notificationSupport());

  const row = (label: string, key: keyof NotifySettings, sub?: string) => (
    <div className="field"><span className="label" style={{ flex: 1 }}>{label}{sub && <span className="row-sub" style={{ display: 'block' }}>{sub}</span>}</span>
      <Switch checked={!!n[key]} onChange={(v) => set({ [key]: v } as Partial<NotifySettings>)} label={label} /></div>
  );

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>通知與提醒</h1>
        <div style={{ width: 44 }} />
      </header>
      <div className="card">
        <p style={{ margin: 0 }}>{STATE_TEXT[perm]}</p>
        {perm === 'needs-install' && isIOS() && (
          <ol className="muted" style={{ fontSize: '0.85rem', paddingLeft: 20, marginBottom: 0 }}>
            <li>用 Safari 開啟本 App 網址</li><li>點「分享」→「加入主畫面」</li><li>從主畫面圖示開啟，再回到這裡開啟通知</li>
          </ol>
        )}
        {perm === 'default' && (
          <button className="btn small" style={{ marginTop: 10 }} onClick={async () => {
            const r = await requestPermission();
            setPerm(r);
            if (r === 'granted') set({ enabled: true });
          }}>允許通知</button>
        )}
      </div>
      <div className="list">
        <div className="field"><span className="label" style={{ flex: 1 }}>系統通知</span>
          <Switch checked={n.enabled && perm === 'granted'} label="系統通知" onChange={async (v) => {
            if (v && perm !== 'granted') { const r = await requestPermission(); setPerm(r); if (r !== 'granted') return; }
            set({ enabled: v });
          }} />
        </div>
      </div>
      <div className="section-title">提醒項目</div>
      <div className="list">
        {row('每日記帳提醒', 'daily', '設定時間後若當天沒有記帳')}
        {n.daily && <div className="field"><span className="label">提醒時間</span><input type="time" value={n.dailyTime} onChange={(e) => set({ dailyTime: e.target.value || '21:00' })} /></div>}
        {row('信用卡繳款提醒', 'cardDue')}
        {n.cardDue && <div className="field"><span className="label">提前天數</span><select value={n.cardDueDays} onChange={(e) => set({ cardDueDays: Number(e.target.value) })}>{[1, 2, 3, 5, 7].map((d) => <option key={d} value={d}>{d} 天</option>)}</select></div>}
        {row('預算警示', 'budget', '達到警示門檻或超支時')}
        {row('訂閱與週期帳目', 'subscription', '續約前提醒、待確認項目')}
        {row('到價提醒', 'priceAlert', '觀察清單中設定的價格')}
        {row('備份提醒', 'backup')}
        {n.backup && <div className="field"><span className="label">每隔</span><select value={n.backupDays} onChange={(e) => set({ backupDays: Number(e.target.value) })}>{[7, 14, 30, 60].map((d) => <option key={d} value={d}>{d} 天</option>)}</select></div>}
      </div>
      <button className="btn tinted" onClick={async () => {
        await notify('🔔 測試通知', '如果你看到這則通知，代表設定成功', '/', 'daily_log', `test:${Date.now()}`);
        useUI.getState().showSnack({ text: perm === 'granted' && n.enabled ? '已送出測試通知' : '已加入提醒中心（系統通知未開啟）' });
      }}>傳送測試通知</button>
      <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => void runReminderChecks().then(() => useUI.getState().showSnack({ text: '已檢查所有提醒' }))}>立即檢查提醒</button>
      <p className="muted" style={{ fontSize: '0.78rem', margin: 8 }}>
        限制說明：本 App 沒有伺服器，無法在關閉時主動推播。提醒會在「開啟 App」與「App 在前景」時檢查並發出；iOS 加入主畫面後，App 在背景短時間內仍可能收到。
      </p>
    </main>
  );
}

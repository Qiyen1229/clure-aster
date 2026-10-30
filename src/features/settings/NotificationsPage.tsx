/**
 * 通知設定：權限引導（iOS 需先加入主畫面、iOS 16.4+）、各類提醒開關、每日提醒時間、測試通知。
 */
import { useEffect, useRef, useState } from 'react';
import { disablePush, enablePush, fetchPushStatus, pushSupported, schedulePush, sendTestPush, type PushStatus } from '@/services/push';
import { AUTH_ENABLED } from '@/stores/auth';
import { useNavigate } from 'react-router-dom';
import { isIOS, notificationSupport, notify, requestPermission, runReminderChecks, type PermissionState } from '@/services/notifications';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import type { NotifySettings } from '@/db/repo/settings';

const STATE_TEXT: Record<PermissionState, string> = {
  granted: '已允許系統通知 ✓',
  denied: '通知已被封鎖。請到 iPhone「設定 → 通知 → Aster」或瀏覽器網站設定中允許。',
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
  const [pushBusy, setPushBusy] = useState(false);
  const [pst, setPst] = useState<PushStatus | null>(null);
  const refreshPst = () => { if (AUTH_ENABLED && n.push) void fetchPushStatus().then(setPst, () => setPst(null)); };
  useEffect(refreshPst, [n.push]);  
  const snack = (text: string) => useUI.getState().showSnack({ text });
  // 提醒設定變更後重新排程背景推播（停止輸入 1.5 秒後）
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!n.push) return;
    const t = setTimeout(() => void schedulePush().catch(() => undefined), 1500);
    return () => clearTimeout(t);
  }, [n]);

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
      {AUTH_ENABLED && (
        <>
          <div className="section-title">背景推播</div>
          <div className="list">
            <div className="field"><span className="label" style={{ flex: 1 }}>App 關閉時也提醒<span className="row-sub" style={{ display: 'block' }}>經你的伺服器發送：每日記帳、繳款、續約、心願、週報月報、備份</span></span>
              <Switch checked={n.push} label="背景推播" onChange={async (v) => {
                setPushBusy(true);
                try {
                  if (v) { await enablePush(); setPerm(notificationSupport()); snack('已啟用背景推播'); }
                  else { await disablePush(); snack('已關閉背景推播'); }
                } catch (e) { snack((e as Error).message); } finally { setPushBusy(false); }
              }} />
            </div>
            {n.push && pst && (
              <div className="row"><span className="row-main row-sub" style={{ whiteSpace: 'normal' }}>
                {pst.subscribed ? '✓ 這台裝置已訂閱' : '✗ 這台裝置尚未訂閱（按下「傳送測試推播」會自動補訂閱）'}　已排程 {pst.scheduled} 則　伺服器共 {pst.devices} 台裝置
                {pst.last_error && <span style={{ display: 'block', color: 'var(--danger)' }}>最近一次發送失敗：{pst.last_error}</span>}
              </span></div>
            )}
            {n.push && <button className="row accent" disabled={pushBusy} onClick={async () => {
              setPushBusy(true);
              try {
                await schedulePush(); // 先確認訂閱與排程都在
                snack(await sendTestPush());
              } catch (e) { snack((e as Error).message); } finally { setPushBusy(false); refreshPst(); }
            }}>傳送測試推播</button>}
            {!pushSupported() && <div className="row"><span className="row-main row-sub" style={{ whiteSpace: 'normal' }}>目前的瀏覽器無法使用背景推播（需 HTTPS；iPhone 需 iOS 16.4 以上並從主畫面開啟）。</span></div>}
          </div>
        </>
      )}
      <div className="section-title">提醒項目</div>
      <div className="list">
        {row('每日記帳提醒', 'daily', '設定時間後若當天沒有記帳')}
        {n.daily && <div className="field"><span className="label">提醒時間</span><input type="time" value={n.dailyTime} onChange={(e) => set({ dailyTime: e.target.value || '21:00' })} /></div>}
        {row('信用卡繳款提醒', 'cardDue')}
        {n.cardDue && <div className="field"><span className="label">提前天數</span><select value={n.cardDueDays} onChange={(e) => set({ cardDueDays: Number(e.target.value) })}>{[1, 2, 3, 5, 7].map((d) => <option key={d} value={d}>{d} 天</option>)}</select></div>}
        {row('預算警示', 'budget', '達到警示門檻或超支時')}
        {row('訂閱與週期帳目', 'subscription', '續約前提醒、待確認項目')}
        {row('到價提醒', 'priceAlert', '觀察清單中設定的價格')}
        {row('每週摘要', 'weekly', '每週第一天早上：上週花了多少、和前一週比')}
        {row('每月月報', 'monthly', '每月第一天早上：收支、儲蓄率、哪一類變多了')}
        {row('備份提醒', 'backup')}
        {n.backup && <div className="field"><span className="label">每隔</span><select value={n.backupDays} onChange={(e) => set({ backupDays: Number(e.target.value) })}>{[7, 14, 30, 60].map((d) => <option key={d} value={d}>{d} 天</option>)}</select></div>}
      </div>
      <button className="btn tinted" onClick={async () => {
        await notify('🔔 測試通知', '如果你看到這則通知，代表設定成功', '/', 'daily_log', `test:${Date.now()}`);
        useUI.getState().showSnack({ text: perm === 'granted' && n.enabled ? '已送出測試通知' : '已加入提醒中心（系統通知未開啟）' });
      }}>傳送測試通知</button>
      <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => void runReminderChecks().then(() => useUI.getState().showSnack({ text: '已檢查所有提醒' }))}>立即檢查提醒</button>
      <p className="muted" style={{ fontSize: '0.78rem', margin: 8 }}>
        沒開背景推播時，提醒只會在「開啟 App」與「App 在前景」時檢查並發出。背景推播由 App 每次開啟時預先排好接下來 14 天的提醒；預算與到價提醒需要即時資料，仍在 App 開啟時檢查。
      </p>
    </main>
  );
}

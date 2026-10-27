/**
 * 備份與匯出：JSON 完整備份（可含照片）／還原（取代或合併）、CSV／Excel 匯出（可選期間）、PDF 報表、匯入精靈。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { AUTH_ENABLED } from '@/stores/auth';
import { exportBackup, exportCSV, exportXLSX, restoreBackup } from '@/services/backup';
import { loadSettings } from '@/db/repo/settings';
import { accountingMonth, todayKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Segmented, Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';

export default function BackupPage() {
  const navigate = useNavigate();
  const msd = useSettings((s) => s.monthStartDay);
  const [photos, setPhotos] = useState(true);
  const [busy, setBusy] = useState('');
  const [mode, setMode] = useState<'replace' | 'merge'>('merge');
  const m = accountingMonth(todayKey(), msd);
  const [range, setRange] = useState({ start: `${todayKey().slice(0, 4)}-01-01`, end: todayKey() });
  const info = useLiveQuery(async () => ({
    last: (await db.meta.get('lastBackupAt'))?.value as number | undefined,
    txs: await db.transactions.count(),
    photos: await db.attachments.count(),
  }), []);
  const snack = (text: string) => useUI.getState().showSnack({ text });
  const run = async (k: string, fn: () => Promise<unknown>) => {
    setBusy(k);
    try { await fn(); } catch (e) { snack(`失敗：${(e as Error).message}`); } finally { setBusy(''); }
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>備份、匯入與匯出</h1>
        <div style={{ width: 44 }} />
      </header>

      <div className="card glass">
        <div>💾 上次備份：<b>{info?.last ? new Date(info.last).toLocaleString('zh-TW') : '從未備份'}</b></div>
        <div className="muted" style={{ fontSize: '0.85rem' }}>{info?.txs ?? 0} 筆帳目、{info?.photos ?? 0} 張照片。帳目會自動同步到你的伺服器；收據照片只存在這台裝置，仍建議定期備份。</div>
      </div>

      <div className="section-title">完整備份（JSON）</div>
      <div className="list">
        <div className="field"><span className="label" style={{ flex: 1 }}>包含收據照片</span><Switch checked={photos} onChange={setPhotos} label="包含照片" /></div>
        <button className="row accent" disabled={!!busy} onClick={() => void run('backup', async () => {
          const r = await exportBackup(photos);
          if (r !== 'cancelled') snack(r === 'shared' ? '已開啟分享表單，可存到「檔案」或 iCloud Drive' : '備份檔已儲存');
        })}>{busy === 'backup' ? '產生中…' : '匯出備份檔'}</button>
      </div>

      <div className="section-title">還原備份</div>
      <div className="list">
        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <Segmented value={mode} onChange={setMode} options={[{ value: 'merge', label: '合併（保留現有）' }, { value: 'replace', label: '完全取代' }]} ariaLabel="還原方式" />
        </div>
        <label className="row accent" style={{ cursor: 'pointer' }}>
          {busy === 'restore' ? '還原中…' : '選擇備份檔並還原'}
          <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            if (mode === 'replace' && !window.confirm(AUTH_ENABLED ? '完全取代會刪除目前所有資料，並同步到這個帳號的其他裝置，確定？' : '完全取代會刪除這台裝置上目前所有資料，確定？')) return;
            void run('restore', async () => {
              const r = await restoreBackup(f, mode);
              useSettings.getState().hydrate(await loadSettings());
              snack(`已還原 ${r.rows} 筆資料`);
            });
          }} />
        </label>
      </div>

      <div className="section-title">匯出表格</div>
      <div className="list">
        <div className="field"><span className="label">開始</span><input type="date" value={range.start} max={range.end} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} /></div>
        <div className="field"><span className="label">結束</span><input type="date" value={range.end} min={range.start} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} /></div>
        <button className="row accent" disabled={!!busy} onClick={() => void run('csv', () => exportCSV(range, `aster-${range.start}_${range.end}`))}>匯出 CSV</button>
        <button className="row accent" disabled={!!busy} onClick={() => void run('xlsx', () => exportXLSX(range, `aster-${range.start}_${range.end}`))}>匯出 Excel（.xlsx，含帳戶、投資、股利）</button>
        <button className="row accent" onClick={() => navigate(`/reports/print?start=${m.start}&end=${m.end}`)}>本月 PDF 報表（列印／儲存為 PDF）</button>
      </div>

      <div className="section-title">匯入</div>
      <div className="list">
        <button className="row" onClick={() => navigate('/settings/import')}>
          <span className="row-main"><span className="row-title">從 CSV／Moze 匯入</span><span className="row-sub" style={{ display: 'block' }}>自動辨識 Moze 匯出檔，其他 App 可手動對應欄位</span></span>
          <Icon name="chevronR" className="row-chev" />
        </button>
      </div>
    </main>
  );
}

/**
 * 資料健康檢查與修復：先檢查、列出問題，使用者逐項確認修復。另顯示儲存空間用量與持久化狀態。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { runHealthCheck, storageEstimate, type HealthIssue } from '@/services/health';
import { useUI } from '@/stores/ui';
import { EmptyState, SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';

export default function HealthPage() {
  const navigate = useNavigate();
  const [issues, setIssues] = useState<HealthIssue[] | null>(null);
  const [store, setStore] = useState<Awaited<ReturnType<typeof storageEstimate>>>(null);
  const [busy, setBusy] = useState('');
  const check = async () => { setIssues(null); setIssues(await runHealthCheck()); };
  useEffect(() => { void check(); void storageEstimate().then(setStore); }, []);
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>資料健康檢查</h1>
        <button className="icon-btn" aria-label="重新檢查" onClick={() => void check()}><Icon name="repeat" /></button>
      </header>
      {store && (
        <div className="card glass">
          <div>儲存空間：<b className="num">{mb(store.usage)}</b> <span className="muted">／ 可用約 {mb(store.quota)}</span></div>
          <div className="bar" style={{ margin: '8px 0' }}><i style={{ width: `${Math.min(100, (store.usage / Math.max(1, store.quota)) * 100)}%` }} /></div>
          <div className="muted" style={{ fontSize: '0.85rem' }}>{store.persisted ? '✓ 已啟用持久化儲存（系統不會自動清除）' : '⚠️ 未啟用持久化儲存：加入主畫面並定期使用可降低被清除的機率，請定期備份'}</div>
        </div>
      )}
      {!issues ? <SkeletonRows n={3} /> : issues.length === 0 ? (
        <EmptyState emoji="✅" title="資料一切正常" text="帳戶餘額與帳目一致、沒有遺失的關聯、沒有多餘的照片。" />
      ) : issues.map((i) => (
        <div key={i.id} className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b className="row-main">{i.title}</b>
            <span className="chip" style={{ ['--c' as string]: 'var(--warning)' }}>{i.count}</span>
          </div>
          <p className="muted" style={{ fontSize: '0.85rem' }}>{i.detail}</p>
          <button className="btn small" disabled={!!busy} onClick={async () => {
            setBusy(i.id);
            try { useUI.getState().showSnack({ text: await i.fix() }); await check(); } finally { setBusy(''); }
          }}>{busy === i.id ? '修復中…' : '修復'}</button>
        </div>
      ))}
    </main>
  );
}

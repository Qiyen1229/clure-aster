/**
 * 「AI 解說」卡片：專案、帳戶等頁面共用。
 * build() 回傳 domain/aisummary 整理的去識別化統計；結果快取在本機，同樣的資料不會重複扣額度。
 */
import { AiMark } from '@/ui/Icon';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { aiExplain, quotaLabel, type InsightsValue } from '@/services/ai';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';

export function AiExplainCard({ subject, build, hint }: { subject: string; build: () => Promise<object>; hint?: string }) {
  const navigate = useNavigate();
  const enabled = useSettings((s) => !!s.ai?.enabled && !!s.ai?.allowData);
  const [res, setRes] = useState<{ v: InsightsValue; cached: boolean; quota?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!AUTH_ENABLED) return null;

  const run = async (force = false) => {
    setBusy(true); setErr('');
    try {
      const r = await aiExplain(subject, await build(), force);
      setRes({ v: r.value, cached: r.cached, quota: r.quota ? quotaLabel(r.quota) : undefined });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (!enabled) {
    return (
      <section className="card" style={{ marginBottom: 12 }}>
        <div className="row-title"><AiMark /> AI 解說</div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>{hint ?? '讓 AI 用幾句話說明重點與建議。'}需要先在設定允許 AI 分析收支統計。</div>
        <button className="btn small tinted" style={{ marginTop: 8 }} onClick={() => navigate('/settings/ai')}>前往 AI 設定</button>
      </section>
    );
  }
  return (
    <section className="card" style={{ marginBottom: 12 }} aria-live="polite">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div className="row-title"><AiMark /> AI 解說</div>
        <button className="btn small" disabled={busy} onClick={() => void run(!!res)}>{busy ? '分析中…' : res ? '重新分析' : '請 AI 解說'}</button>
      </div>
      {err && <p className="row-sub" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{err}</p>}
      {res && (
        <div style={{ marginTop: 8 }}>
          <div className="row-title">{res.v.headline}</div>
          <ul style={{ margin: '6px 0 6px 18px', padding: 0 }}>{res.v.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
          {res.v.suggestion && <p style={{ margin: '6px 0' }}>💡 {res.v.suggestion}</p>}
          <p className="row-sub" style={{ whiteSpace: 'normal' }}>{res.cached ? '使用先前的分析結果（未扣額度）' : res.quota ?? ''}　AI 的解說僅供參考。</p>
        </div>
      )}
    </section>
  );
}

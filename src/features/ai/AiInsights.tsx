/**
 * 「AI 白話解讀」卡片：週報／月報（也用在 AI 助理頁）。
 * 送出的是 domain/aisummary.periodToAi 整理的分類層級統計；結果快取在本機，同一期不會重複扣額度。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCategories } from '@/app/hooks';
import { periodToAi } from '@/domain/aisummary';
import { currencyInfo } from '@/domain/money';
import { aiInsights, quotaLabel, type InsightsValue } from '@/services/ai';
import { loadSummary, summaryRange, summaryTitle, type SummaryUnit } from '@/services/summary';
import { todayKey, type DateKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';

export function AiInsightsCard({ unit, anchor }: { unit: SummaryUnit; anchor: DateKey }) {
  const navigate = useNavigate();
  const base = useSettings((s) => s.baseCurrency);
  const enabled = useSettings((s) => !!s.ai?.enabled && !!s.ai?.allowData);
  const { map: cats } = useCategories();
  const [res, setRes] = useState<{ v: InsightsValue; cached: boolean; quota?: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const key = `${unit}:${anchor}`;
  const shown = res?.key === key ? res : null;

  const run = async (force = false) => {
    setBusy(true); setErr('');
    try {
      const sum = await loadSummary(unit, anchor, todayKey());
      const label = summaryTitle(unit, summaryRange(unit, anchor).range) + (unit === 'week' ? '（週）' : '');
      const r = await aiInsights(label, periodToAi(sum, cats, label, base, currencyInfo(base).exp), force);
      setRes({ v: r.value, cached: r.cached, quota: r.quota ? quotaLabel(r.quota) : undefined, key });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (!enabled) {
    return (
      <section className="card" style={{ marginTop: 12 }}>
        <div className="row-title">✨ AI 白話解讀你的資產狀況</div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>讓 AI 用幾句話說明這一期的重點與建議。需要先在設定允許 AI 分析收支統計。</div>
        <button className="btn small tinted" style={{ marginTop: 8 }} onClick={() => navigate('/settings/ai')}>前往 AI 設定</button>
      </section>
    );
  }
  return (
    <section className="card" style={{ marginTop: 12 }} aria-live="polite">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div className="row-title">✨ AI 白話解讀你的資產狀況</div>
        <button className="btn small" disabled={busy} onClick={() => void run(!!shown)}>{busy ? '分析中…' : shown ? '重新分析' : '請 AI 解讀'}</button>
      </div>
      {err && <p className="row-sub" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{err}</p>}
      {shown && (
        <div style={{ marginTop: 8 }}>
          <div className="row-title">{shown.v.headline}</div>
          <ul style={{ margin: '6px 0 6px 18px', padding: 0 }}>{shown.v.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
          {shown.v.suggestion && <p style={{ margin: '6px 0' }}>💡 {shown.v.suggestion}</p>}
          <p className="row-sub" style={{ whiteSpace: 'normal' }}>{shown.cached ? '使用先前的分析結果（未扣額度）' : shown.quota ?? ''}　AI 的解讀僅供參考。</p>
        </div>
      )}
    </section>
  );
}

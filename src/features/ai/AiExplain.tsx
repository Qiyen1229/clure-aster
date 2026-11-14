/**
 * 「Cilo 解說」卡片：專案、帳戶、週報／月報共用同一個殼（按鈕、載入、快取提示、結果排版）。
 *  - AiExplainCard：專案、帳戶等頁面；build() 回傳 domain/aisummary 整理的去識別化統計
 *  - AiInsightsCard：週報／月報；送出的是 domain/aisummary.periodToAi 整理的分類層級統計
 * 結果快取在本機，同樣的資料不會重複扣額度。
 */
import { AiMark } from '@/ui/Icon';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCategories } from '@/app/hooks';
import { periodToAi } from '@/domain/aisummary';
import { currencyInfo } from '@/domain/money';
import { todayKey, type DateKey } from '@/domain/period';
import { aiExplain, aiInsights, quotaLabel, type AiQuota, type InsightsValue } from '@/services/ai';
import { loadSummary, summaryRange, summaryTitle, type SummaryUnit } from '@/services/summary';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { Hint } from '@/ui/Hint';

type Run = (force: boolean) => Promise<{ value: InsightsValue; cached: boolean; quota?: AiQuota }>;

/** 共用殼：沒開 AI 時引導去設定；開了就顯示按鈕與結果。resetKey 變了（例如換了一期）就不顯示上一期的結果 */
function ExplainShell({ title, hint, offHint, runLabel, run, resetKey, margin, footer }: {
  title: ReactNode; hint: string; offHint: string; runLabel: string; run: Run; resetKey: string; margin: 'top' | 'bottom'; footer: string;
}) {
  const navigate = useNavigate();
  const enabled = useSettings((s) => !!s.ai?.enabled && !!s.ai?.allowData);
  const [res, setRes] = useState<{ v: InsightsValue; cached: boolean; quota?: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const shown = res?.key === resetKey ? res : null;
  const style = margin === 'top' ? { marginTop: 12 } : { marginBottom: 12 };

  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await run(!!shown);
      setRes({ v: r.value, cached: r.cached, quota: r.quota ? quotaLabel(r.quota) : undefined, key: resetKey });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (!enabled) {
    return (
      <section className="card" style={style}>
        <Hint id="ai.explain" title={title} hint={`${offHint}需要先在設定允許 Cilo 分析收支統計。`} />
        <button className="btn small tinted" style={{ marginTop: 8 }} onClick={() => navigate('/settings/ai')}>前往 Cilo設定</button>
      </section>
    );
  }
  return (
    <section className="card" style={style} aria-live="polite">
      <Hint id="ai.explain" title={title} hint={hint}
        right={<button className="btn small" disabled={busy} onClick={() => void go()}>{busy ? '分析中…' : shown ? '重新分析' : runLabel}</button>} />
      {err && <p className="row-sub" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{err}</p>}
      {shown && (
        <div style={{ marginTop: 8 }}>
          <div className="row-title">{shown.v.headline}</div>
          <ul style={{ margin: '6px 0 6px 18px', padding: 0 }}>{shown.v.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
          {shown.v.suggestion && <p style={{ margin: '6px 0' }}>💡 {shown.v.suggestion}</p>}
          <p className="row-sub" style={{ whiteSpace: 'normal' }}>{shown.cached ? '使用先前的分析結果（未扣額度）' : shown.quota ?? ''}　{footer}</p>
        </div>
      )}
    </section>
  );
}

export function AiExplainCard({ subject, build, hint }: { subject: string; build: () => Promise<object>; hint?: string }) {
  if (!AUTH_ENABLED) return null;
  const text = hint ?? '讓 Cilo 用幾句話說明重點與建議。';
  return (
    <ExplainShell title={<><AiMark /> Cilo 解說</>} hint={`${text}同樣的資料結果會快取，不會重複扣額度。`} offHint={text} runLabel="請 Cilo 解說"
      resetKey={subject} margin="bottom" footer="Cilo 的解說僅供參考。" run={async (force) => aiExplain(subject, await build(), force)} />
  );
}

export function AiInsightsCard({ unit, anchor }: { unit: SummaryUnit; anchor: DateKey }) {
  const base = useSettings((s) => s.baseCurrency);
  const { map: cats } = useCategories();
  return (
    <ExplainShell title={<><AiMark /> Cilo 白話解讀你的資產狀況</>} hint="讓 Cilo 用幾句話說明這一期的重點與建議；同一期結果會快取，不會重複扣額度。" offHint="讓 Cilo 用幾句話說明這一期的重點與建議。"
      runLabel="請 Cilo 解讀" resetKey={`${unit}:${anchor}`} margin="top" footer="Cilo 的解讀僅供參考。"
      run={async (force) => {
        const sum = await loadSummary(unit, anchor, todayKey());
        const label = summaryTitle(unit, summaryRange(unit, anchor).range) + (unit === 'week' ? '（週）' : '');
        return aiInsights(label, periodToAi(sum, cats, label, base, currencyInfo(base).exp), force);
      }} />
  );
}

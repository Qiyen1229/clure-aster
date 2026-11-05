/**
 * 對話裡的「財務自由」檢視卡：和財務自由頁同一套蒙地卡羅（domain/fire），用你設定的報酬、波動與提領率。
 * 兩根拉桿（退休年齡、每年可存）只影響這張卡，隨時重算、不改你的設定；沒有任何 AI 呼叫。
 * 傳入 params 時（例如「如果 55 歲退休」）拉桿從那個值開始。
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { simulateFire } from '@/domain/fire';
import { currencyInfo, formatMoney, fromMinor, toMinor } from '@/domain/money';
import { loadFireBasis } from '@/services/fireBasis';
import { useSettings } from '@/stores/settings';
import { chartTheme } from '@/features/reports/chart-theme';
import type { ViewSpec } from '@/domain/agent/plan';

const EChart = lazy(() => import('@/features/reports/EChart'));

export function FireView({ params, refreshKey }: { params: ViewSpec['params']; refreshKey?: string }) {
  const navigate = useNavigate();
  const base = useSettings((s) => s.baseCurrency);
  const fire = useSettings((s) => s.fire);
  const data = useLiveQuery(() => loadFireBasis(), [refreshKey]);
  const [retire, setRetire] = useState<number | null>(params.retire_age ?? null);
  const [saveOv, setSaveOv] = useState<number | null>(params.annual_saving ?? null);
  const major = (minor: number) => fromMinor(minor, base).toNumber();
  const age = new Date().getFullYear() - fire.birthYear;
  const expense = fire.annualExpense || (data ? major(data.expense) : 0);
  const saving0 = fire.annualSaving || (data ? Math.max(0, major(data.income - data.expense)) : 0);
  const start = fire.startAssets || (data ? major(data.netWorth) : 0);
  const retireAge = Math.max(age, retire ?? fire.retireAge);
  const saving = saveOv ?? saving0;

  const result = useMemo(() => {
    if (!data || !(expense > 0) || age < 0 || age >= fire.endAge) return null;
    return simulateFire({
      currentAge: age, retireAge, endAge: fire.endAge, netWorth: start, annualExpense: expense, annualSaving: saving,
      expectedReturn: fire.returnPct / 100, volatility: fire.volPct / 100, inflation: fire.inflationPct / 100, withdrawalRate: fire.swrPct / 100, runs: 400, seed: 2026,
    });
  }, [data, expense, saving, age, start, retireAge, fire]);
  const money = (v: number) => formatMoney(toMinor(Math.round(v), base), base, { decimals: 0 });
  const option = useMemo(() => {
    if (!result) return null;
    const t = chartTheme();
    return {
      grid: { left: 4, right: 8, top: 8, bottom: 20, containLabel: true },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
      xAxis: { type: 'category', data: result.ages, axisLabel: { color: t.text2, interval: Math.max(0, Math.round(result.ages.length / 6) - 1) } },
      yAxis: { type: 'value', axisLabel: { color: t.text2, formatter: (v: number) => { const a = Math.abs(v); return a >= 1e8 ? `${(v / 1e8).toFixed(1)}億` : a >= 1e4 ? `${Math.round(v / 1e4)}萬` : String(v); } }, splitLine: { lineStyle: { color: t.sep } } },
      series: [
        { name: 'P10', type: 'line', data: result.p10, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 } },
        { name: 'P10～P90', type: 'line', data: result.p90.map((v, i) => v - result.p10[i]), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: t.accent, opacity: 0.18 } },
        { name: 'P50', type: 'line', data: result.p50, symbol: 'none', lineStyle: { width: 2.2, color: t.accent } },
        { name: '自由門檻', type: 'line', data: result.target, symbol: 'none', lineStyle: { type: 'dashed', color: t.text2 } },
      ],
    };
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="skeleton" style={{ height: 140 }} />;
  if (!result) return <p className="muted" style={{ margin: 0 }}>要先設定出生年與年支出（近 12 個月沒有支出紀錄時請到財務自由頁手動輸入）。<button className="attn-link" onClick={() => navigate('/reports/fire')}>前往 →</button></p>;
  const sym = currencyInfo(base).symbol;
  return (
    <div className="view-card">
      <div className="stat-grid">
        <div className="stat"><div className="k">達成年齡（中位數）</div><div className="v num">{result.medianFiAge ?? '—'}{result.medianFiAge ? ' 歲' : ''}</div></div>
        <div className="stat"><div className="k">{retireAge} 歲退休撐到 {fire.endAge}</div><div className="v num" style={{ color: result.retireSuccess < 0.7 ? 'var(--danger)' : undefined }}>{Math.round(result.retireSuccess * 100)}%</div></div>
        <div className="stat"><div className="k">自由門檻</div><div className="v num">{money(expense / (fire.swrPct / 100))}</div></div>
      </div>
      {option && <Suspense fallback={<div className="skeleton" style={{ height: 150 }} />}><EChart option={option} height={150} ariaLabel="資產模擬分位數與財務自由門檻" /></Suspense>}
      <label className="view-slider"><span>退休年齡 <b className="num">{retireAge}</b> 歲</span>
        <input type="range" min={Math.max(age, 35)} max={Math.min(75, fire.endAge - 1)} step={1} value={retireAge} onChange={(e) => setRetire(Number(e.target.value))} aria-label="退休年齡" /></label>
      <label className="view-slider"><span>每年可存 <b className="num">{sym}{Math.round(saving).toLocaleString('zh-TW')}</b></span>
        <input type="range" min={0} max={Math.max(1_000_000, Math.round(saving0 * 2 / 10000) * 10000)} step={10000} value={Math.round(saving)} onChange={(e) => setSaveOv(Number(e.target.value))} aria-label="每年可存" /></label>
      <p className="row-sub" style={{ whiteSpace: 'normal', margin: '4px 0 0' }}>拉桿只影響這張卡，不會改你的設定。模擬 400 次；{' '}<button className="attn-link" onClick={() => navigate('/reports/fire')}>完整財務自由試算 →</button></p>
    </div>
  );
}

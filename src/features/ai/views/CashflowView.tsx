/** 對話裡的「現金流預測」檢視卡：未來 N 天可動用的錢、最低點、哪天哪個帳戶會不夠付（和現金流頁同一套算法） */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatMoney } from '@/domain/money';
import { todayKey } from '@/domain/period';
import { buildCashflow, type CashflowData } from '@/services/cashflow';
import { chartTheme } from '@/features/reports/chart-theme';
import type { ViewSpec } from '@/domain/agent/plan';

const EChart = lazy(() => import('@/features/reports/EChart'));
const short = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

export function CashflowView({ params, refreshKey }: { params: ViewSpec['params']; refreshKey?: string }) {
  const navigate = useNavigate();
  const days = params.days ?? 90;
  const [data, setData] = useState<CashflowData | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    setData(null);
    buildCashflow(days, true).then((d) => alive && setData(d), (e) => alive && setErr((e as Error).message));
    return () => { alive = false; };
  }, [days, refreshKey]);
  const base = data?.base ?? 'TWD';
  const money = (v: number) => formatMoney(v, base, { decimals: 0 });
  const option = useMemo(() => {
    if (!data) return null;
    const t = chartTheme();
    return {
      grid: { left: 4, right: 8, top: 8, bottom: 20, containLabel: true },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
      xAxis: { type: 'category', data: data.series.map((p) => short(p.date)), axisLabel: { color: t.text2, interval: Math.max(0, Math.round(data.series.length / 5) - 1) }, boundaryGap: false },
      yAxis: { type: 'value', scale: true, axisLabel: { color: t.text2, formatter: (v: number) => { const a = Math.abs(v / 100); return a >= 1e4 ? `${(v / 100 / 1e4).toFixed(a >= 1e5 ? 0 : 1)}萬` : String(Math.round(v / 100)); } }, splitLine: { lineStyle: { color: t.sep } } },
      series: [{ type: 'line', data: data.series.map((p) => p.total), symbol: 'none', smooth: 0.2, lineStyle: { width: 2.2, color: t.accent }, areaStyle: { color: t.accent, opacity: 0.12 },
        markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0 }], lineStyle: { color: t.neg, type: 'dashed' }, label: { show: false } } }],
    };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <p className="muted" style={{ margin: 0 }}>無法計算：{err}</p>;
  if (!data) return <div className="skeleton" style={{ height: 140 }} />;
  if (!data.accounts.length) return <p className="muted" style={{ margin: 0 }}>還沒有現金、銀行或電子支付帳戶，先到「帳戶」新增才能預測。</p>;
  const today = todayKey();
  return (
    <div className="view-card">
      <div className="stat-grid">
        <div className="stat"><div className="k">現在可動用</div><div className="v num">{money(data.start)}</div></div>
        <div className="stat"><div className="k">最低點 · {short(data.lowest.date)}</div><div className="v num" style={{ color: data.lowest.total < 0 ? 'var(--danger)' : undefined }}>{money(data.lowest.total)}</div></div>
        <div className="stat"><div className="k">{days} 天後</div><div className="v num">{money(data.end)}</div></div>
      </div>
      {option && <Suspense fallback={<div className="skeleton" style={{ height: 150 }} />}><EChart option={option} height={150} ariaLabel={`未來 ${days} 天可動用金額走勢`} /></Suspense>}
      {data.shortfalls.length > 0
        ? data.shortfalls.slice(0, 3).map((s) => <p key={s.accountId} style={{ margin: '4px 0', fontSize: '0.88rem' }} role="alert">⚠️ <b>{short(s.date)}</b>「{s.label}」之後有帳戶會不夠付，記得先轉帳進去。</p>)
        : data.lowest.total >= 0 && <p className="row-sub" style={{ margin: '4px 0 0' }}>✓ 未來 {days} 天（從 {short(today)} 起）預估都付得出來。</p>}
      <button className="attn-link" onClick={() => navigate('/reports/cashflow')}>完整現金流預測 →</button>
    </div>
  );
}

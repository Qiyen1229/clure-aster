/**
 * 財務自由試算：以目前淨資產、近 12 個月收支（可手動覆蓋）與報酬假設，跑 1,000 次蒙地卡羅模擬。
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { totals } from '@/domain/ledger';
import { addDays, todayKey } from '@/domain/period';
import { currencyInfo, formatMoney, fromMinor, toMinor } from '@/domain/money';
import { simulateFire } from '@/domain/fire';
import { netWorthSeries } from '@/services/networth';
import type { FireSettings } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';
import { SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { chartTheme } from './chart-theme';

const EChart = lazy(() => import('./EChart'));

function NumField({ label, value, onChange, suffix, step = 1 }: { label: string; value: number; onChange: (v: number) => void; suffix?: string; step?: number }) {
  const id = `fire-${label}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" inputMode="decimal" step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(Number(e.target.value))} className="num" />
      {suffix && <span className="muted">{suffix}</span>}
    </div>
  );
}

export default function FirePage() {
  const navigate = useNavigate();
  const base = useSettings((s) => s.baseCurrency);
  const fire = useSettings((s) => s.fire);
  const set = useSettings((s) => s.set);
  const [draft, setDraft] = useState<FireSettings>(fire);
  const upd = (patch: Partial<FireSettings>) => { const next = { ...draft, ...patch }; setDraft(next); set('fire', next); };

  const data = useLiveQuery(async () => {
    const since = addDays(todayKey(), -365);
    const txs = (await db.transactions.where('date').aboveOrEqual(since).toArray()).filter((t) => !t.deletedAt);
    const t = totals(txs);
    const nw = (await netWorthSeries(0)).at(-1)?.netWorth ?? 0;
    // 記帳不滿一年時依實際天數換算成全年（至少以 30 天計）
    const first = txs.reduce((m, x) => (x.date < m ? x.date : m), todayKey());
    const days = Math.max(30, Math.round((Date.parse(todayKey()) - Date.parse(first)) / 86400000) + 1);
    const k = days < 365 ? 365 / days : 1;
    return { netWorth: nw, expense: Math.round(t.expense * k), income: Math.round(t.income * k), days: Math.min(days, 365) };
  }, []);

  const major = (minor: number) => fromMinor(minor, base).toNumber();
  const expense = draft.annualExpense || (data ? major(data.expense) : 0);
  const saving = draft.annualSaving || (data ? Math.max(0, major(data.income - data.expense)) : 0);
  const age = new Date().getFullYear() - draft.birthYear;
  const start = draft.startAssets || (data ? major(data.netWorth) : 0);

  const result = useMemo(() => {
    if (!data || !(expense > 0) || age < 0 || age >= draft.endAge) return null;
    return simulateFire({
      currentAge: age, retireAge: Math.max(age, draft.retireAge), endAge: draft.endAge, netWorth: start,
      annualExpense: expense, annualSaving: saving, expectedReturn: draft.returnPct / 100, volatility: draft.volPct / 100,
      inflation: draft.inflationPct / 100, withdrawalRate: draft.swrPct / 100, runs: 1000, seed: 2026,
    });
  }, [data, expense, saving, age, start, draft]);  

  const money = (v: number) => formatMoney(toMinor(Math.round(v), base), base, { decimals: 0 });
  const pAt = (a: number) => (result ? result.fiProbability[Math.max(0, Math.min(result.ages.length - 1, a - age))] : 0);
  const option = useMemo(() => {
    if (!result) return null;
    const t = chartTheme();
    const step = Math.max(1, Math.round(result.ages.length / 12));
    return {
      grid: { left: 8, right: 12, top: 28, bottom: 24, containLabel: true },
      legend: { top: 0, textStyle: { color: t.text2 }, data: ['P50', 'P10～P90', '自由門檻'] },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
      xAxis: { type: 'category', data: result.ages, axisLabel: { color: t.text2, interval: step - 1 } },
      yAxis: { type: 'value', axisLabel: { color: t.text2, formatter: (v: number) => { const a = Math.abs(v), sign = v < 0 ? '-' : ''; return a >= 1e8 ? `${sign}${(a / 1e8).toFixed(1)}億` : a >= 1e4 ? `${sign}${Math.round(a / 1e4)}萬` : String(v); } }, splitLine: { lineStyle: { color: t.sep } } },
      series: [
        { name: 'P10～P90', type: 'line', data: result.p10, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 } },
        { name: 'P10～P90', type: 'line', data: result.p90.map((v, i) => v - result.p10[i]), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: t.accent, opacity: 0.18 } },
        { name: 'P50', type: 'line', data: result.p50, symbol: 'none', lineStyle: { width: 2.5, color: t.accent } },
        { name: '自由門檻', type: 'line', data: result.target, symbol: 'none', lineStyle: { type: 'dashed', color: t.text2 } },
      ],
    };
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>財務自由試算</h1>
        <div style={{ width: 44 }} />
      </header>
      {!data ? <SkeletonRows n={4} /> : (
        <>
          <section className="card glass">
            {result ? (
              <>
                <div className="stat-grid">
                  <div className="stat"><div className="k">達成年齡（中位數）</div><div className="v num">{result.medianFiAge ?? '—'}{result.medianFiAge ? ' 歲' : ''}</div></div>
                  <div className="stat"><div className="k">{draft.retireAge} 歲前達成機率</div><div className="v num">{Math.round(pAt(draft.retireAge) * 100)}%</div></div>
                  <div className="stat"><div className="k">{draft.retireAge} 歲退休撐到 {draft.endAge} 歲</div><div className="v num" style={{ color: result.retireSuccess < 0.7 ? 'var(--danger)' : undefined }}>{Math.round(result.retireSuccess * 100)}%</div></div>
                </div>
                <p className="muted" style={{ fontSize: '0.8rem', margin: '10px 0 0' }}>
                  門檻＝年支出 ÷ 安全提領率＝<b>{money(expense / (draft.swrPct / 100))}</b>（今日幣值）。不考慮波動時約 {result.deterministicFiAge ?? '—'} 歲達成。
                </p>
              </>
            ) : <p className="muted" style={{ margin: 0 }}>請確認出生年與年支出（近 12 個月沒有支出紀錄時請手動輸入）。</p>}
          </section>

          {option && (
            <Suspense fallback={<SkeletonRows n={3} />}>
              <section className="card"><EChart option={option} height={260} ariaLabel="資產模擬分位數與財務自由門檻" /></section>
            </Suspense>
          )}

          {result && (
            <>
              <div className="section-title">各年齡達成機率</div>
              <div className="card">
                {[40, 45, 50, 55, 60, 65].filter((a) => a > age && a <= draft.endAge).map((a) => (
                  <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
                    <span className="num" style={{ width: 44 }}>{a} 歲</span>
                    <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--surface-3)', overflow: 'hidden' }}>
                      <div style={{ width: `${pAt(a) * 100}%`, height: '100%', background: 'var(--accent)' }} />
                    </div>
                    <span className="num" style={{ width: 44, textAlign: 'right' }}>{Math.round(pAt(a) * 100)}%</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="section-title">目前狀況</div>
          <div className="list">
            <div className="row"><span className="row-main">淨資產（含投資）</span><span className="num">{formatMoney(data.netWorth, base)}</span></div>
            <NumField label="起始資產" value={draft.startAssets || Math.round(major(data.netWorth))} onChange={(v) => upd({ startAssets: v })} suffix={currencyInfo(base).symbol} step={10000} />
            <NumField label="年支出" value={draft.annualExpense || Math.round(major(data.expense))} onChange={(v) => upd({ annualExpense: v })} suffix={currencyInfo(base).symbol} step={1000} />
            <NumField label="每年可存" value={draft.annualSaving || Math.round(Math.max(0, major(data.income - data.expense)))} onChange={(v) => upd({ annualSaving: v })} suffix={currencyInfo(base).symbol} step={1000} />
            {data.days < 365 && !draft.annualExpense && <div className="row"><span className="row-main row-sub" style={{ whiteSpace: 'normal' }}>記帳資料只有 {data.days} 天，年支出與儲蓄已依天數換算成全年。</span></div>}
            {(draft.annualExpense > 0 || draft.annualSaving > 0 || draft.startAssets !== 0) && (
              <button className="row accent" onClick={() => upd({ annualExpense: 0, annualSaving: 0, startAssets: 0 })}>改回依記帳資料估算</button>
            )}
          </div>
          {data.netWorth < 0 && !draft.startAssets && (
            <p className="muted" style={{ fontSize: '0.8rem', margin: '-4px 8px 12px' }}>淨資產為負（例如房貸尚未扣掉房屋價值），建議把「起始資產」改成可用於退休的資產（存款＋投資）。</p>
          )}

          <div className="section-title">假設</div>
          <div className="list">
            <NumField label="出生年" value={draft.birthYear} onChange={(v) => upd({ birthYear: v })} suffix={`${age} 歲`} />
            <NumField label="想退休年齡" value={draft.retireAge} onChange={(v) => upd({ retireAge: v })} suffix="歲" />
            <NumField label="規劃到" value={draft.endAge} onChange={(v) => upd({ endAge: v })} suffix="歲" />
            <NumField label="年化報酬" value={draft.returnPct} onChange={(v) => upd({ returnPct: v })} suffix="%" step={0.5} />
            <NumField label="波動度" value={draft.volPct} onChange={(v) => upd({ volPct: v })} suffix="%" step={1} />
            <NumField label="通膨" value={draft.inflationPct} onChange={(v) => upd({ inflationPct: v })} suffix="%" step={0.5} />
            <NumField label="安全提領率" value={draft.swrPct} onChange={(v) => upd({ swrPct: v })} suffix="%" step={0.5} />
          </div>
          <p className="disclaimer">模擬結果僅供規劃參考，不構成投資建議。股債 60/40 的長期年化報酬約 5–7%、波動 10–15%；全股票約 7–9%、波動 15–20%。</p>
        </>
      )}
    </main>
  );
}

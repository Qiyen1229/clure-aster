/**
 * 現金流預測：未來 30／90／180 天「可動用的錢」會怎麼變化。
 * 最低點、哪一天哪個帳戶不夠付卡費、接下來的固定收支清單。
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatMoney } from '@/domain/money';
import { shortDate } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { buildCashflow, type CashflowData } from '@/services/cashflow';
import { Segmented, SkeletonRows, Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { chartTheme } from './chart-theme';

const EChart = lazy(() => import('./EChart'));
const KIND_ICON = { recurring: '🔁', card: '💳', installment: '🧾', loan: '🏦' } as const;

export default function CashflowPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState(90);
  const [withSpend, setWithSpend] = useState(true);
  const [data, setData] = useState<CashflowData | null>(null);
  const [error, setError] = useState('');
  const today = todayKey();

  useEffect(() => {
    let alive = true;
    buildCashflow(days, withSpend).then((d) => { if (alive) { setData(d); setError(''); } }, (e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [days, withSpend]);

  const base = data?.base ?? 'TWD';
  const money = (v: number) => formatMoney(v, base, { decimals: 0 });
  const accName = useMemo(() => new Map(data?.accounts.map((a) => [a.id, a]) ?? []), [data]);

  const option = useMemo(() => {
    if (!data) return null;
    const t = chartTheme();
    const step = Math.max(1, Math.round(data.series.length / 6));
    const fmt = (v: number) => { const a = Math.abs(v / 100), s = v < 0 ? '-' : ''; return a >= 1e4 ? `${s}${(a / 1e4).toFixed(a >= 1e5 ? 0 : 1)}萬` : `${s}${Math.round(a)}`; };
    return {
      grid: { left: 8, right: 12, top: 16, bottom: 24, containLabel: true },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) },
      xAxis: { type: 'category', data: data.series.map((p) => shortDate(p.date, today)), axisLabel: { color: t.text2, interval: step - 1 }, boundaryGap: false },
      yAxis: { type: 'value', scale: true, axisLabel: { color: t.text2, formatter: fmt }, splitLine: { lineStyle: { color: t.sep } } },
      series: [{
        name: '可動用金額', type: 'line', data: data.series.map((p) => p.total), symbol: 'none', smooth: 0.2,
        lineStyle: { width: 2.5, color: t.accent }, areaStyle: { color: t.accent, opacity: 0.12 },
        markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0 }], lineStyle: { color: t.neg, type: 'dashed' }, label: { show: false } },
      }],
    };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const upcoming = data?.events.slice(0, 40) ?? [];
  const assumed = data?.events.some((e) => e.assumed);

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>現金流預測</h1>
        <div style={{ width: 44 }} />
      </header>
      <Segmented value={days} onChange={setDays} ariaLabel="預測天數" options={[{ value: 30, label: '30 天' }, { value: 90, label: '90 天' }, { value: 180, label: '半年' }]} />
      {error && <div className="card"><p style={{ margin: 0 }}>無法計算：{error}</p></div>}
      {!data ? <SkeletonRows n={4} /> : data.accounts.length === 0 ? (
        <div className="card"><p style={{ margin: 0 }}>還沒有現金、銀行或電子支付帳戶。先到「帳戶」新增，才能預測可動用的錢。</p></div>
      ) : (
        <>
          <section className="card glass" style={{ marginTop: 12 }}>
            <div className="stat-grid">
              <div className="stat"><div className="k">現在可動用</div><div className="v num">{money(data.start)}</div></div>
              <div className="stat"><div className="k">最低點 · {shortDate(data.lowest.date, today)}</div>
                <div className="v num" style={{ color: data.lowest.total < 0 ? 'var(--danger)' : undefined }}>{money(data.lowest.total)}</div></div>
              <div className="stat"><div className="k">{days} 天後</div><div className="v num">{money(data.end)}</div></div>
            </div>
            {option && <Suspense fallback={<div style={{ height: 220 }} />}><EChart option={option} height={220} ariaLabel={`未來 ${days} 天可動用金額走勢`} /></Suspense>}
            <label className="field" style={{ padding: '8px 0 0', minHeight: 0 }}>
              <span className="row-main" style={{ fontSize: '0.85rem' }}>
                包含日常花費推估
                <span className="row-sub" style={{ display: 'block' }}>近 90 天平均每天 {money(data.dailySpend)}（吃飯、交通等不固定的支出）</span>
              </span>
              <Switch checked={withSpend} onChange={setWithSpend} label="包含日常花費推估" />
            </label>
          </section>

          {data.shortfalls.length > 0 && (
            <section className="card cash-warn" role="alert">
              <b>⚠️ 這些帳戶會不夠付</b>
              {data.shortfalls.map((s) => {
                const a = accName.get(s.accountId);
                return (
                  <p key={s.accountId}>
                    <b>{shortDate(s.date, today)}</b>「{s.label}」之後，<b>{a?.name}</b> 會不足 <span className="num">{formatMoney(-s.balanceMinor, a?.currency ?? base)}</span>，記得先轉帳進去。
                  </p>
                );
              })}
            </section>
          )}
          {data.shortfalls.length === 0 && data.lowest.total >= 0 && (
            <p className="muted" style={{ fontSize: '0.85rem', margin: '4px 8px' }}>✅ 依目前已知的收支，未來 {days} 天每個帳戶都付得出來。</p>
          )}
          {!data.hasIncome && (
            <div className="card" style={{ fontSize: '0.85rem' }}>
              💡 還沒有設定薪水等固定收入，曲線只會往下走。到「專案 → 週期」把薪水設成每月的週期收入，預測會準很多。
              <button className="btn tinted small" style={{ marginTop: 8 }} onClick={() => navigate('/plan?tab=recurring')}>前往設定</button>
            </div>
          )}

          <div className="section-title">接下來的固定收支</div>
          {upcoming.length === 0 ? <p className="muted" style={{ margin: '0 8px' }}>沒有已知的週期帳目、卡費、分期或貸款。</p> : (
            <div className="list">
              {upcoming.map((e, i) => {
                const a = accName.get(e.accountId);
                return (
                  <div key={i} className="row with-icon">
                    <span className="cat-icon sm" aria-hidden="true">{KIND_ICON[e.kind]}</span>
                    <span className="row-main">
                      <span className="row-title">{e.label}</span>
                      <span className="row-sub" style={{ display: 'block' }}>{shortDate(e.date, today)} · {a?.name}{e.assumed ? '（假設）' : ''}</span>
                    </span>
                    <span className={`num ${e.amountMinor > 0 ? 'pos' : 'neg'}`}>{formatMoney(e.amountMinor, a?.currency ?? base, { sign: 'always' })}</span>
                  </div>
                );
              })}
            </div>
          )}
          {assumed && <p className="muted" style={{ fontSize: '0.78rem', margin: '6px 8px' }}>標示「假設」的卡費或貸款沒有設定扣款帳戶，先假設從餘額最多的帳戶扣。信用卡可在「編輯帳戶 → 扣繳帳戶」指定；貸款在貸款帳戶頁的「扣款帳戶」選擇。</p>}
          <p className="muted" style={{ fontSize: '0.78rem', margin: '6px 8px' }}>
            可動用的錢＝現金、銀行、電子支付、儲值帳戶。信用卡的消費會在繳款日從扣款帳戶扣掉；外幣帳戶以目前匯率換算。
          </p>
        </>
      )}
    </main>
  );
}

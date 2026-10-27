/**
 * 投資總覽（帳戶頁 → 投資）：
 * 市場狀態與最後更新、下拉／按鈕重新整理、總覽（市值、成本、未實現、已實現、今日、報酬率、含股利、XIRR、股價／匯差損益）、
 * 配置圓餅（個股／產業／市場／幣別）、資產與損益曲線（每日快照）、持股列表、損益排行、已出清、免責聲明。
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { MARKET_STATE_LABEL, marketState } from '@/domain/invest/market-hours';
import { formatMoney } from '@/domain/money';
import { usePortfolio, fmtShares, type Holding } from '@/services/portfolio';
import { snapshotSeries } from '@/services/networth';
import { updateAllQuotes } from '@/services/startup';
import { describeQuoteErrors } from '@/services/quotes/registry';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { PullToRefresh } from '@/ui/PullToRefresh';
import { chartTheme } from '../reports/chart-theme';
import { MARKET_LABEL } from './StockSearch';
import { TradeSheet } from './TradeSheet';

const EChart = lazy(() => import('../reports/EChart'));

export const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

export function StaleBadge({ h }: { h: Pick<Holding, 'price' | 'stale'> }) {
  if (!h.price) return <span className="chip" style={{ ['--c' as string]: 'var(--warning)' }}>無報價</span>;
  if (h.price.isManual) return <span className="chip" style={{ ['--c' as string]: 'var(--warning)' }}>手動</span>;
  if (h.stale) return <span className="chip" style={{ ['--c' as string]: 'var(--text-3)' }}>非最新</span>;
  return null;
}

export default function InvestTab() {
  const navigate = useNavigate();
  const pf = usePortfolio();
  const base = useSettings((s) => s.baseCurrency);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [alloc, setAlloc] = useState<'stock' | 'industry' | 'market' | 'currency'>('stock');
  const [range, setRange] = useState<30 | 90 | 365 | 3650>(90);
  const snaps = useLiveQuery(() => snapshotSeries(range), [range, pf?.lastUpdated]);
  const t = chartTheme();

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await updateAllQuotes();
      if (r) useUI.getState().showSnack({ text: r.failed.length ? `已更新 ${r.updated} 檔，${r.failed.length} 檔失敗：${describeQuoteErrors(r.errors)}` : `已更新 ${r.updated} 檔（${[...r.sources].join('、')}）`, duration: r.failed.length ? 7000 : undefined });
    } finally { setBusy(false); }
  };

  const markets = useMemo(() => [...new Set((pf?.holdings ?? []).map((h) => (h.stock.market === 'US' ? 'US' : h.stock.market === 'HK' ? 'HK' : 'TWSE')))], [pf]);

  const allocOption = useMemo(() => {
    if (!pf?.holdings.length) return null;
    const m = new Map<string, number>();
    for (const h of pf.holdings) {
      const k = alloc === 'stock' ? h.stock.name : alloc === 'industry' ? h.stock.industry || (h.stock.assetType === 'etf' ? 'ETF' : '未分類')
        : alloc === 'market' ? MARKET_LABEL[h.stock.market] : h.stock.currency;
      m.set(k, (m.get(k) ?? 0) + (h.val?.marketValueBaseMinor ?? h.pos.costBaseMinor));
    }
    const data = [...m].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));
    return {
      tooltip: { trigger: 'item', valueFormatter: (v: number) => formatMoney(v, base) },
      legend: { type: 'scroll', bottom: 0, textStyle: { color: t.text2 }, itemWidth: 10, itemHeight: 10 },
      series: [{ type: 'pie', radius: ['45%', '72%'], center: ['50%', '44%'], label: { show: false }, itemStyle: { borderRadius: 6, borderColor: t.surface, borderWidth: 2 }, data }],
    };
  }, [pf, alloc, base]); // eslint-disable-line react-hooks/exhaustive-deps

  const curveOption = useMemo(() => {
    if (!snaps || snaps.length < 2) return null;
    return {
      grid: { left: 8, right: 8, top: 24, bottom: 4, containLabel: true },
      legend: { top: 0, right: 0, textStyle: { color: t.text2 }, itemWidth: 10, itemHeight: 10 },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatMoney(v, base) },
      xAxis: { type: 'category', boundaryGap: false, data: snaps.map((s) => s.date.slice(5).replace('-', '/')), axisLabel: { color: t.text3 }, axisLine: { lineStyle: { color: t.sep } } },
      yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: t.sep, type: 'dashed' } }, axisLabel: { color: t.text3, formatter: (v: number) => formatMoney(v, base, { compact: true }).replace('$', '') } },
      series: [
        { name: '市值', type: 'line', smooth: true, symbol: 'none', data: snaps.map((s) => s.investMarketValueMinor), lineStyle: { color: t.accent, width: 2.5 }, areaStyle: { color: t.accent, opacity: 0.1 } },
        { name: '成本', type: 'line', smooth: true, symbol: 'none', data: snaps.map((s) => s.investCostMinor), lineStyle: { color: t.text3, width: 1.5, type: 'dashed' } },
        { name: '未實現損益', type: 'line', smooth: true, symbol: 'none', data: snaps.map((s) => s.unrealizedPnlMinor), lineStyle: { color: t.pos, width: 1.5 } },
      ],
    };
  }, [snaps, base]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pf) return <SkeletonRows n={4} />;
  const ranked = [...pf.holdings].filter((h) => h.val).sort((a, b) => (b.val!.unrealizedPct - a.val!.unrealizedPct));

  return (
    <PullToRefresh onRefresh={refresh}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 8px', flexWrap: 'wrap' }}>
        {(markets.length ? markets : ['TWSE']).map((m) => {
          const st = marketState(m as 'TWSE');
          return <span key={m} className="chip" style={{ ['--c' as string]: st === 'open' ? 'var(--success)' : 'var(--text-3)' }}>{m === 'TWSE' ? '台股' : m === 'US' ? '美股' : '港股'} {MARKET_STATE_LABEL[st]}</span>;
        })}
        <span className="muted" style={{ fontSize: '0.75rem', flex: 1 }}>{pf.lastUpdated ? `更新於 ${new Date(pf.lastUpdated).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}` : '尚未更新'}</span>
        <button className="icon-btn" aria-label="重新整理報價" onClick={() => void refresh()} disabled={busy}><Icon name="repeat" className={busy ? 'spin' : ''} /></button>
      </div>

      {pf.holdings.length === 0 && pf.closed.length === 0 ? (
        <EmptyState emoji="📈" title="還沒有持股" text="新增第一筆買進交易，就能看到即時市值、損益、報酬率與股利。"
          action={<button className="btn small" onClick={() => setAdding(true)}>新增交易</button>} />
      ) : (
        <>
          <section className="card glass" aria-label="投資組合總覽">
            <div className="muted" style={{ fontSize: '0.8rem' }}>總市值（{base}）</div>
            <div className="hero-num num"><Amount minor={pf.marketValueBase} currency={base} tone="none" animate /></div>
            <div className="num" style={{ fontSize: '0.95rem', marginTop: 2 }}>
              <Amount minor={pf.unrealizedBase} currency={base} tone="auto" opts={{ sign: 'always' }} />
              <span className={pf.unrealizedBase >= 0 ? 'pos' : 'neg'}>（{pct(pf.costBase ? (pf.unrealizedBase / pf.costBase) * 100 : 0)}）</span>
              <span className="muted"> 今日 </span><Amount minor={pf.todayBase} currency={base} tone="auto" opts={{ sign: 'always' }} />
            </div>
            <div className="stat-grid" style={{ marginTop: 12 }}>
              <div className="stat"><div className="k">總成本</div><div className="v num"><Amount minor={pf.costBase} currency={base} tone="none" opts={{ compact: true }} /></div></div>
              <div className="stat"><div className="k">已實現</div><div className="v num"><Amount minor={pf.realizedBase} currency={base} tone="auto" opts={{ compact: true }} /></div></div>
              <div className="stat"><div className="k">累計股利</div><div className="v num"><Amount minor={pf.dividendsBase} currency={base} tone="none" opts={{ compact: true }} /></div></div>
              <div className="stat"><div className="k">總報酬率</div><div className={`v num ${pf.totalReturnPct >= 0 ? 'pos' : 'neg'}`}>{pct(pf.totalReturnPct)}</div></div>
              <div className="stat"><div className="k">含股利</div><div className={`v num ${pf.totalReturnWithDivPct >= 0 ? 'pos' : 'neg'}`}>{pct(pf.totalReturnWithDivPct)}</div></div>
              <div className="stat"><div className="k">年化 XIRR</div><div className={`v num ${(pf.xirr ?? 0) >= 0 ? 'pos' : 'neg'}`}>{pf.xirr === null ? '—' : pct(pf.xirr * 100)}</div></div>
            </div>
            {pf.fxPnlBase !== 0 && (
              <p className="muted num" style={{ fontSize: '0.8rem', margin: '10px 0 0' }}>
                外幣損益拆分：股價 <Amount minor={pf.pricePnlBase} currency={base} tone="auto" opts={{ sign: 'always' }} />・匯差 <Amount minor={pf.fxPnlBase} currency={base} tone="auto" opts={{ sign: 'always' }} />
              </p>
            )}
            {pf.missingPrice > 0 && <p style={{ fontSize: '0.8rem', color: 'var(--warning)', margin: '8px 0 0' }}>⚠️ {pf.missingPrice} 檔沒有報價，以成本計算市值。可進入個股手動輸入現價。</p>}
          </section>

          <div className="btn-row" style={{ marginBottom: 12 }}>
            <button className="btn small" style={{ flex: 1 }} onClick={() => setAdding(true)}><Icon name="plus" size={16} />交易</button>
            <button className="btn small tinted" style={{ flex: 1 }} onClick={() => navigate('/invest/watchlist')}>觀察清單</button>
            <button className="btn small tinted" style={{ flex: 1 }} onClick={() => navigate('/invest/dividends')}>股利</button>
          </div>

          <div className="section-title">持股（{pf.holdings.length}）</div>
          <div className="list">
            {pf.holdings.map((h) => (
              <button key={h.stock.id} className="row" onClick={() => navigate(`/invest/stock/${h.stock.id}`)} style={{ alignItems: 'flex-start' }}>
                <div className="row-main">
                  <div className="row-title"><b className="num">{h.stock.symbol}</b> {h.stock.name} <StaleBadge h={h} /></div>
                  <div className="row-sub num">{fmtShares(h.pos.shares)} 股 · 均價 {h.pos.avgCost.toDecimalPlaces(2).toString()} · 現價 {h.price?.priceDec ? Number(h.price.priceDec).toLocaleString('zh-TW', { maximumFractionDigits: 4 }) : '—'}
                    {h.price && <span className={Number(h.price.changeDec) >= 0 ? 'pos' : 'neg'}> {pct(Number(h.price.changePctDec))}</span>}</div>
                </div>
                <div className="row-end">
                  <div className="num" style={{ fontWeight: 600 }}><Amount minor={h.val?.marketValueMinor ?? h.pos.costMinor} currency={h.stock.currency} tone="none" /></div>
                  {h.val && <div className="num" style={{ fontSize: '0.8rem' }}><Amount minor={h.val.unrealizedMinor} currency={h.stock.currency} tone="auto" opts={{ sign: 'always' }} /> <span className={h.val.unrealizedMinor >= 0 ? 'pos' : 'neg'}>{pct(h.val.unrealizedPct)}</span></div>}
                </div>
              </button>
            ))}
          </div>

          {allocOption && (
            <section className="card" aria-label="資產配置">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <b style={{ flex: 1 }}>資產配置</b>
              </div>
              <Segmented value={alloc} onChange={setAlloc} options={[{ value: 'stock', label: '個股' }, { value: 'industry', label: '產業' }, { value: 'market', label: '市場' }, { value: 'currency', label: '幣別' }]} ariaLabel="配置依據" />
              <Suspense fallback={<div className="skeleton" style={{ height: 240 }} />}><EChart option={allocOption} height={240} ariaLabel="資產配置圓餅圖" /></Suspense>
            </section>
          )}

          <section className="card" aria-label="資產與損益曲線">
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <b style={{ flex: 1 }}>市值與損益</b>
              <div style={{ width: 200 }}><Segmented value={range} onChange={setRange} options={[{ value: 30, label: '1M' }, { value: 90, label: '3M' }, { value: 365, label: '1Y' }, { value: 3650, label: 'ALL' }]} ariaLabel="期間" /></div>
            </div>
            {curveOption ? <Suspense fallback={<div className="skeleton" style={{ height: 200 }} />}><EChart option={curveOption} height={200} ariaLabel="市值與損益曲線" /></Suspense>
              : <p className="muted" style={{ fontSize: '0.85rem' }}>每天開啟 App 會自動記錄一筆資產快照（缺漏日期自動補齊），累積兩天以上就會畫出曲線。</p>}
          </section>

          {ranked.length > 1 && (
            <section className="card" aria-label="損益排行">
              <b>損益排行</b>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                {[{ title: '賺最多', list: ranked.slice(0, 3) }, { title: '賠最多', list: [...ranked].reverse().slice(0, 3) }].map((g) => (
                  <div key={g.title}>
                    <div className="muted" style={{ fontSize: '0.75rem', marginBottom: 4 }}>{g.title}</div>
                    {g.list.map((h) => (
                      <button key={h.stock.id} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', padding: '4px 0', minHeight: 32 }} onClick={() => navigate(`/invest/stock/${h.stock.id}`)}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.stock.name}</span>
                        <span className={`num ${h.val!.unrealizedPct >= 0 ? 'pos' : 'neg'}`}>{pct(h.val!.unrealizedPct)}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          )}

          {pf.closed.length > 0 && (
            <>
              <div className="section-title">已出清</div>
              <div className="list">
                {pf.closed.map((h) => (
                  <button key={h.stock.id} className="row" onClick={() => navigate(`/invest/stock/${h.stock.id}`)}>
                    <span className="row-main">{h.stock.symbol} {h.stock.name}</span>
                    <span className="row-sub">已實現</span>
                    <Amount minor={h.pos.realizedMinor} currency={h.stock.currency} tone="auto" opts={{ sign: 'always' }} className="num" />
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
      <p className="disclaimer">報價可能延遲，僅供參考，不構成投資建議。<br />{pf.lastUpdated ? `資料時間 ${new Date(pf.lastUpdated).toLocaleString('zh-TW')}` : ''}</p>
      <TradeSheet open={adding} onClose={() => setAdding(false)} />
    </PullToRefresh>
  );
}

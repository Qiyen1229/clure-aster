/**
 * 個股頁：現價與漲跌、市場狀態、走勢（1D/1W/1M/3M/1Y/ALL，標示平均成本）、持倉計算、
 * 「若今天賣出」扣除費稅後淨損益、成本／現價殖利率、交易與股利紀錄、手動輸入現價、加入觀察清單。
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { StockTrade } from '@/db/types';
import { addWatch, removeWatch } from '@/db/repo/invest';
import { MARKET_STATE_LABEL, marketState } from '@/domain/invest/market-hours';
import { formatMoney } from '@/domain/money';
import { usePortfolio, fmtShares } from '@/services/portfolio';
import { fetchHistory, refreshQuotes, setManualPrice } from '@/services/quotes/registry';
import type { Bar, HistoryRange } from '@/services/quotes/providers';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { chartTheme } from '../reports/chart-theme';
import { MARKET_LABEL } from './StockSearch';
import { TradeSheet } from './TradeSheet';
import { DividendSheet } from './DividendsPage';
import { pct, StaleBadge } from './InvestTab';

const EChart = lazy(() => import('../reports/EChart'));
const TYPE_LABEL: Record<StockTrade['type'], string> = { buy: '買進', sell: '賣出', stock_dividend: '配股', split: '分割' };

export default function StockDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const base = useSettings((s) => s.baseCurrency);
  const stock = useLiveQuery(() => db.stocks.get(id), [id]);
  const price = useLiveQuery(() => db.price_cache.get(id), [id]);
  const trades = useLiveQuery(() => db.stock_trades.where('stockId').equals(id).filter((t) => !t.deletedAt).toArray(), [id]);
  const dividends = useLiveQuery(() => db.dividends.where('stockId').equals(id).toArray(), [id]);
  const watch = useLiveQuery(() => db.watchlist.where('stockId').equals(id).first(), [id]);
  const pf = usePortfolio();
  const h = pf ? [...pf.holdings, ...pf.closed].find((x) => x.stock.id === id) : undefined;
  const [range, setRange] = useState<HistoryRange>('3m');
  const [hist, setHist] = useState<{ bars: Bar[]; source: string; offline: boolean } | null>(null);
  const [trade, setTrade] = useState<{ t?: StockTrade; type?: StockTrade['type'] } | null>(null);
  const [divOpen, setDivOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [mp, setMp] = useState('');
  const [busy, setBusy] = useState(false);
  const t = chartTheme();

  useEffect(() => {
    if (!stock) return;
    let alive = true;
    setHist(null);
    fetchHistory(stock, range).then((r) => alive && setHist(r)).catch(() => alive && setHist({ bars: [], source: '', offline: true }));
    return () => { alive = false; };
  }, [stock?.id, range]); // eslint-disable-line react-hooks/exhaustive-deps

  const chartOption = useMemo(() => {
    if (!hist?.bars.length) return null;
    const up = hist.bars[hist.bars.length - 1].close >= hist.bars[0].close;
    const color = up ? t.pos : t.neg;
    const avg = h && h.pos.shares.gt(0) ? h.pos.avgCost.toNumber() : null;
    return {
      grid: { left: 4, right: 4, top: 12, bottom: 4, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', boundaryGap: false, data: hist.bars.map((b) => (range === '1d' ? new Date(b.t).toTimeString().slice(0, 5) : b.date.slice(2).replace(/-/g, '/'))), axisLabel: { color: t.text3 }, axisLine: { lineStyle: { color: t.sep } } },
      yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: t.sep, type: 'dashed' } }, axisLabel: { color: t.text3 } },
      series: [{
        type: 'line', smooth: true, symbol: 'none', data: hist.bars.map((b) => +b.close.toFixed(4)), lineStyle: { color, width: 2 }, areaStyle: { color, opacity: 0.1 },
        markLine: avg ? { symbol: 'none', label: { formatter: `均價 ${avg.toFixed(2)}`, color: t.text2, position: 'insideEndTop' }, lineStyle: { color: t.text3, type: 'dashed' }, data: [{ yAxis: avg }] } : undefined,
      }],
    };
  }, [hist, h, range]); // eslint-disable-line react-hooks/exhaustive-deps

  if (stock === undefined) return <main className="page"><SkeletonRows /></main>;
  if (!stock) return <main className="page"><EmptyState emoji="🤔" title="找不到標的" action={<button className="btn small" onClick={() => navigate('/accounts?tab=invest')}>回投資</button>} /></main>;
  const st = marketState(stock.market);
  const chg = price ? Number(price.changeDec) : 0;
  const cur = stock.currency;

  const refresh = async () => {
    setBusy(true);
    const r = await refreshQuotes([stock]).finally(() => setBusy(false));
    useUI.getState().showSnack({ text: r.updated ? `已更新（${[...r.sources].join('、')}）` : `更新失敗：${r.errors[0] ?? '所有資料源皆失敗'}，可手動輸入現價` });
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>{stock.symbol}</h1>
        <button className="icon-btn" aria-label={watch ? '移出觀察清單' : '加入觀察清單'} onClick={() => (watch ? void removeWatch(watch.id) : void addWatch(stock.id))}>
          <Icon name="template" className={watch ? 'accent' : ''} />
        </button>
      </header>
      <section style={{ padding: '0 4px 8px' }}>
        <div style={{ fontWeight: 600 }}>{stock.name} <span className="muted" style={{ fontSize: '0.8rem' }}>{MARKET_LABEL[stock.market]}{stock.industry ? ` · ${stock.industry}` : ''} · {cur}</span></div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span className="hero-num num">{price ? Number(price.priceDec).toLocaleString('zh-TW', { maximumFractionDigits: 4 }) : '—'}</span>
          {price && <span className={`num ${chg >= 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 600 }}>{chg >= 0 ? '▲' : '▼'} {Math.abs(chg).toLocaleString('zh-TW', { maximumFractionDigits: 4 })}（{pct(Number(price.changePctDec))}）</span>}
          {h && <StaleBadge h={h} />}
        </div>
        <div className="muted" style={{ fontSize: '0.78rem', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="chip" style={{ ['--c' as string]: st === 'open' ? 'var(--success)' : 'var(--text-3)' }}>{MARKET_STATE_LABEL[st]}</span>
          {price ? `${price.isManual ? '手動輸入' : price.source} · ${new Date(price.marketTime).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '尚無報價'}
          {price?.highDec && <span className="num">高 {price.highDec} / 低 {price.lowDec}</span>}
          <button className="accent" onClick={() => void refresh()} disabled={busy} style={{ minHeight: 32 }}>{busy ? '更新中…' : '重新整理'}</button>
          <button className="accent" onClick={() => { setMp(price?.priceDec ?? ''); setManual(true); }} style={{ minHeight: 32 }}>手動輸入現價</button>
        </div>
      </section>

      <section className="card">
        <Segmented value={range} onChange={setRange} ariaLabel="走勢期間"
          options={(['1d', '1w', '1m', '3m', '1y', 'all'] as HistoryRange[]).map((r) => ({ value: r, label: r.toUpperCase() }))} />
        {!hist ? <div className="skeleton" style={{ height: 200, marginTop: 8 }} /> : chartOption ? (
          <Suspense fallback={<div className="skeleton" style={{ height: 200 }} />}><EChart option={chartOption} height={200} ariaLabel={`${stock.name} 走勢圖`} /></Suspense>
        ) : <p className="muted" style={{ textAlign: 'center', padding: 24 }}>{hist.offline ? '離線或資料源暫時無法取得走勢' : '沒有走勢資料'}</p>}
        {hist && hist.bars.length > 0 && <div className="muted" style={{ fontSize: '0.7rem', textAlign: 'right' }}>資料來源：{hist.source}{hist.offline ? '（離線快取）' : ''}</div>}
      </section>

      {h && (
        <section className="card glass" aria-label="持倉">
          <div className="stat-grid">
            <div className="stat"><div className="k">持有股數</div><div className="v num">{fmtShares(h.pos.shares)}</div></div>
            <div className="stat"><div className="k">平均成本</div><div className="v num">{h.pos.avgCost.toDecimalPlaces(4).toString()}</div></div>
            <div className="stat"><div className="k">總成本</div><div className="v num"><Amount minor={h.pos.costMinor} currency={cur} tone="none" opts={{ compact: true }} /></div></div>
            <div className="stat"><div className="k">市值</div><div className="v num"><Amount minor={h.val?.marketValueMinor ?? 0} currency={cur} tone="none" opts={{ compact: true }} /></div></div>
            <div className="stat"><div className="k">未實現</div><div className="v num"><Amount minor={h.val?.unrealizedMinor ?? 0} currency={cur} tone="auto" opts={{ compact: true }} /></div><div className={`k ${(h.val?.unrealizedPct ?? 0) >= 0 ? 'pos' : 'neg'}`}>{pct(h.val?.unrealizedPct ?? 0)}</div></div>
            <div className="stat"><div className="k">今日</div><div className="v num"><Amount minor={h.val?.todayChangeMinor ?? 0} currency={cur} tone="auto" opts={{ compact: true }} /></div></div>
            <div className="stat"><div className="k">已實現</div><div className="v num"><Amount minor={h.pos.realizedMinor} currency={cur} tone="auto" opts={{ compact: true }} /></div></div>
            <div className="stat"><div className="k">累計股利</div><div className="v num"><Amount minor={h.dividendsBaseMinor} currency={base} tone="none" opts={{ compact: true }} /></div></div>
            <div className="stat"><div className="k">XIRR</div><div className="v num">{h.xirr === null ? '—' : pct(h.xirr * 100)}</div></div>
          </div>
          {h.sellNowNetMinor !== undefined && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: '0.9rem' }}>
              <span>若今天全部賣出（扣手續費與稅）</span>
              <b className="num"><Amount minor={h.sellNowNetMinor} currency={cur} tone="auto" opts={{ sign: 'always' }} /></b>
            </div>
          )}
          <div className="muted num" style={{ fontSize: '0.8rem', marginTop: 6 }}>
            殖利率（近 12 個月）：成本 {h.costYieldPct.toFixed(2)}%・現價 {h.priceYieldPct.toFixed(2)}%
          </div>
          {cur !== base && h.val && (
            <div className="muted num" style={{ fontSize: '0.8rem', marginTop: 6 }}>
              換算 {base}：市值 {formatMoney(h.val.marketValueBaseMinor, base)}・總損益 <Amount minor={h.val.unrealizedBaseMinor} currency={base} tone="auto" opts={{ sign: 'always' }} />
              （股價 <Amount minor={h.val.pricePnlBaseMinor} currency={base} tone="auto" opts={{ sign: 'always' }} />・匯差 <Amount minor={h.val.fxPnlBaseMinor} currency={base} tone="auto" opts={{ sign: 'always' }} />）
            </div>
          )}
          {cur === base ? null : <div className="muted" style={{ fontSize: '0.7rem' }}>目前匯率 1 {cur} = {h.fxNow} {base}</div>}
        </section>
      )}

      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className="btn small" style={{ flex: 1 }} onClick={() => setTrade({ type: 'buy' })}>買進</button>
        <button className="btn small tinted" style={{ flex: 1 }} onClick={() => setTrade({ type: 'sell' })}>賣出</button>
        <button className="btn small tinted" style={{ flex: 1 }} onClick={() => setDivOpen(true)}>股利</button>
      </div>

      <div className="section-title">交易紀錄</div>
      {!trades?.length ? <EmptyState emoji="🧾" title="尚無交易" /> : (
        <div className="list">
          {trades.sort((a, b) => (a.date < b.date ? 1 : -1)).map((tr) => (
            <button key={tr.id} className="row" onClick={() => setTrade({ t: tr })}>
              <span className="chip" style={{ ['--c' as string]: tr.type === 'buy' ? 'var(--c-pos)' : tr.type === 'sell' ? 'var(--c-neg)' : 'var(--accent)' }}>{TYPE_LABEL[tr.type]}</span>
              <div className="row-main">
                <div className="row-title num">{tr.type === 'split' ? `1 拆 ${tr.sharesDec}` : `${Number(tr.sharesDec).toLocaleString('zh-TW')} 股${tr.type === 'buy' || tr.type === 'sell' ? ` @ ${tr.priceDec}` : ''}`}</div>
                <div className="row-sub">{tr.date}{tr.isDCA ? ' · 定期定額' : ''}{tr.feeMinor ? ` · 費 ${formatMoney(tr.feeMinor, cur)}` : ''}{tr.taxMinor ? ` · 稅 ${formatMoney(tr.taxMinor, cur)}` : ''}</div>
              </div>
              {h?.pos.realized.find((r) => r.tradeId === tr.id) && <Amount minor={h.pos.realized.find((r) => r.tradeId === tr.id)!.pnlMinor} currency={cur} tone="auto" opts={{ sign: 'always' }} className="num" />}
            </button>
          ))}
        </div>
      )}
      {dividends && dividends.length > 0 && (
        <>
          <div className="section-title">股利</div>
          <div className="list">
            {dividends.sort((a, b) => (a.payDate < b.payDate ? 1 : -1)).map((d) => (
              <div key={d.id} className="row">
                <div className="row-main">
                  <div className="row-title">{d.kind === 'cash' ? `現金股利 ${d.perShareDec} 元／股` : `股票股利 ${d.perShareDec} 股／股`}</div>
                  <div className="row-sub">除息 {d.exDate} · 發放 {d.payDate}{d.status === 'announced' ? ' · 尚未發放' : ''}</div>
                </div>
                {d.kind === 'cash' && <Amount minor={d.netMinor} currency={d.currency} tone="pos" className="num" />}
              </div>
            ))}
          </div>
        </>
      )}
      <p className="disclaimer">報價可能延遲，僅供參考，不構成投資建議。</p>

      <TradeSheet open={!!trade} onClose={() => setTrade(null)} stockId={stock.id} trade={trade?.t} initialType={trade?.type ?? 'buy'} />
      <DividendSheet open={divOpen} onClose={() => setDivOpen(false)} stockId={stock.id} />
      <Sheet open={manual} onClose={() => setManual(false)} title="手動輸入現價">
        <p className="muted" style={{ marginTop: 0 }}>當所有資料源都無法取得報價時使用。下次自動更新成功後會被覆蓋。</p>
        <input className="input num" inputMode="decimal" value={mp} onChange={(e) => setMp(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="現價" autoFocus />
        <button className="btn" style={{ marginTop: 12 }} disabled={!Number(mp)} onClick={async () => { await setManualPrice(stock.id, mp); setManual(false); }}>儲存</button>
      </Sheet>
    </main>
  );
}

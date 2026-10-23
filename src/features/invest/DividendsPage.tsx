/**
 * 股利管理：現金股利／股票股利（配股）、除息日／發放日、扣繳與二代健保、自動入帳；年度累計。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Decimal from 'decimal.js';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Dividend, StockTrade } from '@/db/types';
import { deleteDividend, nhiSupplement, saveDividend } from '@/db/repo/invest';
import { computePosition } from '@/domain/invest/position';
import { convertMinor, currencyInfo, formatMoney, fromMinor, toMinor } from '@/domain/money';
import { todayKey } from '@/domain/period';
import { resolveRate } from '@/services/fx';
import { useAccounts } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { AccountField, AmountField, DateField, SelectField, SwitchField } from '@/ui/form';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { lazy, Suspense } from 'react';
import { dividendCalendar } from '@/domain/dividend-calendar';
import { usePortfolio } from '@/services/portfolio';
import { chartTheme } from '../reports/chart-theme';

const EChart = lazy(() => import('../reports/EChart'));

/**
 * 股利行事曆：1～12 月已領（實心）與預估（淡色）堆疊長條圖，點月份看明細。
 */
function DividendCalendar({ base }: { base: string }) {
  const [year, setYear] = useState(Number(todayKey().slice(0, 4)));
  const [month, setMonth] = useState<number | null>(null);
  const divs = useLiveQuery(() => db.dividends.toArray(), []);
  const stocks = useLiveQuery(async () => new Map((await db.stocks.toArray()).map((s) => [s.id, s])), []);
  const rates = useLiveQuery(async () => new Map((await db.exchange_rates.toArray()).map((r) => [`${r.base}>${r.quote}`, r])), []);
  const pf = usePortfolio();
  const t = chartTheme();

  const cal = useMemo(() => {
    if (!divs || !pf || !rates) return null;
    const holdings = new Map(pf.holdings.map((h) => [h.stock.id, { sharesDec: h.pos.shares.toString(), currency: h.stock.currency, exp: currencyInfo(h.stock.currency).exp }]));
    const toBase = (v: number, cur: string) => (cur === base ? v : convertMinor(v, cur, base, resolveRate(rates, cur, base) ?? 1));
    return dividendCalendar({ year, today: todayKey(), dividends: divs, holdings, toBase });
  }, [divs, pf, rates, year, base]);

  if (!cal) return <div className="skeleton" style={{ height: 220, marginBottom: 12 }} />;
  const option = {
    grid: { left: 8, right: 8, top: 28, bottom: 4, containLabel: true },
    legend: { top: 0, right: 0, textStyle: { color: t.text2 }, itemWidth: 10, itemHeight: 10 },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatMoney(v, base) },
    xAxis: { type: 'category', data: cal.months.map((m) => `${m.month}月`), axisLabel: { color: t.text3 }, axisLine: { lineStyle: { color: t.sep } } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: t.sep, type: 'dashed' } }, axisLabel: { color: t.text3, formatter: (v: number) => formatMoney(v, base, { compact: true }).replace('$', '') } },
    series: [
      { name: '已領', type: 'bar', stack: 'd', data: cal.months.map((m) => m.paidMinor), itemStyle: { color: t.pos, borderRadius: [0, 0, 0, 0] }, barMaxWidth: 20 },
      { name: '預估', type: 'bar', stack: 'd', data: cal.months.map((m) => m.projectedMinor), itemStyle: { color: t.pos, opacity: 0.35, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 20 },
    ],
  };
  const sel = month ? cal.months[month - 1] : null;
  const total = cal.paidMinor + cal.projectedMinor;
  return (
    <section className="card" aria-label="股利行事曆">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ flex: 1 }}>股利行事曆</b>
        <button className="icon-btn plain" aria-label="上一年" onClick={() => { setYear(year - 1); setMonth(null); }}><Icon name="chevronL" /></button>
        <span className="num" style={{ fontWeight: 600 }}>{year}</span>
        <button className="icon-btn plain" aria-label="下一年" onClick={() => { setYear(year + 1); setMonth(null); }}><Icon name="chevronR" /></button>
      </div>
      <div className="stat-grid" style={{ margin: '8px 0' }}>
        <div className="stat"><div className="k">已領</div><div className="v num"><Amount minor={cal.paidMinor} currency={base} tone="pos" /></div></div>
        <div className="stat"><div className="k">預估待領</div><div className="v num"><Amount minor={cal.projectedMinor} currency={base} tone="none" /></div></div>
        <div className="stat"><div className="k">全年／月均</div><div className="v num"><Amount minor={Math.round(total / 12)} currency={base} tone="none" opts={{ decimals: 0 }} /></div></div>
      </div>
      <Suspense fallback={<div className="skeleton" style={{ height: 200 }} />}>
        <EChart option={option} height={200} ariaLabel={`${year} 年每月股利長條圖`} onClick={(p) => setMonth(p.dataIndex + 1)} />
      </Suspense>
      {sel ? (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: '0.8rem', marginBottom: 4 }}>{year} 年 {sel.month} 月</div>
          {sel.items.length === 0 ? <p className="muted" style={{ margin: 0 }}>這個月沒有股利</p> : sel.items.map((it, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '0.88rem' }}>
              <span>{stocks?.get(it.stockId)?.name ?? '?'} <span className="muted">{it.kind === 'paid' ? '已領' : it.kind === 'announced' ? '已公告' : '依去年推估'}・每股 {it.perShareDec}</span></span>
              <span className="num">{formatMoney(it.amountMinor, base)}</span>
            </div>
          ))}
        </div>
      ) : <p className="muted" style={{ fontSize: '0.75rem', margin: '6px 0 0' }}>點長條看當月明細。預估 = 去年同月每股股利 × 目前持股（未來月份）；已公告的股利以公告金額計。</p>}
    </section>
  );
}

export default function DividendsPage() {
  const navigate = useNavigate();
  const base = useSettings((s) => s.baseCurrency);
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Dividend | null>(null);
  const divs = useLiveQuery(() => db.dividends.toArray(), []);
  const stocks = useLiveQuery(async () => new Map((await db.stocks.toArray()).map((s) => [s.id, s])), []);
  const rates = useLiveQuery(async () => new Map((await db.exchange_rates.toArray()).map((r) => [`${r.base}>${r.quote}`, r])), []);
  const toBase = (d: Dividend) => (d.currency === base ? d.netMinor : convertMinor(d.netMinor, d.currency, base, (rates && resolveRate(rates, d.currency, base)) ?? 1));

  const byYear = useMemo(() => {
    const m = new Map<string, Dividend[]>();
    for (const d of (divs ?? []).sort((a, b) => (a.payDate < b.payDate ? 1 : -1))) {
      const y = d.payDate.slice(0, 4);
      m.set(y, [...(m.get(y) ?? []), d]);
    }
    return [...m];
  }, [divs]);

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>股利</h1>
        <button className="icon-btn" aria-label="新增股利" onClick={() => setAdding(true)}><Icon name="plus" /></button>
      </header>
      {divs && divs.length > 0 && <DividendCalendar base={base} />}
      {!divs ? <SkeletonRows /> : divs.length === 0 ? (
        <EmptyState emoji="💰" title="還沒有股利紀錄" text="記錄現金股利會自動入帳成收入；股票股利（配股）會增加持股並降低平均成本。"
          action={<button className="btn small" onClick={() => setAdding(true)}>新增股利</button>} />
      ) : byYear.map(([y, list]) => (
        <section key={y}>
          <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{y} 年</span>
            <span className="num">現金合計 {formatMoney(list.filter((d) => d.kind === 'cash' && d.status === 'paid').reduce((a, d) => a + toBase(d), 0), base)}</span>
          </div>
          <div className="list">
            {list.map((d) => {
              const s = stocks?.get(d.stockId);
              return (
                <button key={d.id} className="row" onClick={() => setEdit(d)}>
                  <div className="row-main">
                    <div className="row-title">{s?.name ?? '?'} <span className="muted num">{s?.symbol}</span></div>
                    <div className="row-sub">{d.kind === 'cash' ? `現金 ${d.perShareDec}／股` : `配股 ${d.perShareDec} 股／股`} · 發放 {d.payDate}{d.status === 'announced' ? ' · 尚未發放' : ''}</div>
                  </div>
                  {d.kind === 'cash' ? <Amount minor={d.netMinor} currency={d.currency} tone={d.status === 'paid' ? 'pos' : 'none'} className="num" /> : <span className="num">+{new Decimal(d.sharesHeldDec).mul(d.perShareDec).floor().toString()} 股</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      <DividendSheet open={adding || !!edit} dividend={edit ?? undefined} onClose={() => { setAdding(false); setEdit(null); }} />
    </main>
  );
}

export function DividendSheet({ open, onClose, stockId, dividend }: { open: boolean; onClose: () => void; stockId?: string; dividend?: Dividend }) {
  return (
    <Sheet open={open} onClose={onClose} title={dividend ? '編輯股利' : '新增股利'} full>
      {open && <DividendForm key={dividend?.id ?? stockId ?? 'new'} stockId={dividend?.stockId ?? stockId} dividend={dividend} onClose={onClose} />}
    </Sheet>
  );
}

function DividendForm({ stockId: initialStock, dividend, onClose }: { stockId?: string; dividend?: Dividend; onClose: () => void }) {
  const accounts = useAccounts();
  const settings = useSettings();
  const stocks = useLiveQuery(() => db.stocks.toArray(), []) ?? [];
  const [stockId, setStockId] = useState(initialStock ?? '');
  const stock = stocks.find((s) => s.id === stockId);
  const cur = stock?.currency ?? 'TWD';
  const trades = useLiveQuery(() => (stockId ? db.stock_trades.where('stockId').equals(stockId).toArray() : Promise.resolve([] as StockTrade[])), [stockId]) ?? [];
  const [kind, setKind] = useState<Dividend['kind']>(dividend?.kind ?? 'cash');
  const [exDate, setExDate] = useState(dividend?.exDate ?? todayKey());
  const [payDate, setPayDate] = useState(dividend?.payDate ?? todayKey());
  const [perShare, setPerShare] = useState(dividend?.perShareDec ?? '');
  const [shares, setShares] = useState(dividend?.sharesHeldDec ?? '');
  const [withholding, setWithholding] = useState(dividend ? fromMinor(dividend.withholdingTaxMinor, dividend.currency).toString() : '');
  const [nhi, setNhi] = useState(dividend ? fromMinor(dividend.nhiSupplementMinor, dividend.currency).toString() : '');
  const [fee, setFee] = useState(dividend ? fromMinor(dividend.feeMinor, dividend.currency).toString() : cur === 'TWD' ? '10' : '0');
  const [accountId, setAccountId] = useState(dividend?.accountId ?? accounts.list.find((a) => a.type === 'brokerage')?.brokerage?.settlementAccountId ?? accounts.list.find((a) => a.type === 'brokerage')?.id ?? accounts.list[0]?.id ?? '');
  const [status, setStatus] = useState<Dividend['status']>(dividend?.status ?? 'paid');
  const [sync, setSync] = useState(true);

  // 除息日前一天的持股數自動帶入
  useEffect(() => {
    if (dividend || !trades.length) return;
    const before = trades.filter((t) => t.date < exDate);
    const p = computePosition(before, settings.invest.costMethod, currencyInfo(cur).exp);
    setShares(p.shares.toString());
  }, [trades.length, exDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const gross = useMemo(() => {
    try { return kind === 'cash' && perShare && shares ? toMinor(new Decimal(perShare).mul(shares), cur) : 0; } catch { return 0; }
  }, [perShare, shares, kind, cur]);

  // 自動建議：美股預扣 30%、台股單次 ≥ 2 萬扣二代健保 2.11%
  useEffect(() => {
    if (dividend || kind !== 'cash') return;
    if (cur === 'USD') setWithholding(fromMinor(Math.floor(gross * 0.3), cur).toString());
    setNhi(fromMinor(nhiSupplement(gross, cur), cur).toString());
  }, [gross]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = (v: string) => (v ? toMinor(new Decimal(v || 0), cur) : 0);
  const net = Math.max(0, gross - m(withholding) - m(nhi) - m(fee));

  const save = async () => {
    if (!stock) return useUI.getState().showSnack({ text: '請選擇標的' });
    if (!perShare || !shares) return useUI.getState().showSnack({ text: '請輸入每股股利與持股數' });
    await saveDividend({
      stockId: stock.id, accountId, kind, exDate, payDate, perShareDec: new Decimal(perShare).toString(), sharesHeldDec: new Decimal(shares).toString(),
      grossMinor: gross, withholdingTaxMinor: m(withholding), nhiSupplementMinor: m(nhi), feeMinor: m(fee), netMinor: kind === 'cash' ? net : 0,
      currency: cur, status, syncToLedger: sync,
    }, dividend?.id);
    useUI.getState().showSnack({ text: kind === 'cash' && status === 'paid' && sync ? '已記錄並入帳' : '已記錄' });
    onClose();
  };

  return (
    <>
      <Segmented value={kind} onChange={setKind} options={[{ value: 'cash', label: '現金股利' }, { value: 'stock', label: '股票股利（配股）' }]} ariaLabel="股利種類" />
      <div className="list" style={{ marginTop: 12 }}>
        <SelectField label="標的" value={stockId} onChange={setStockId} options={[{ value: '', label: '請選擇' }, ...stocks.map((s) => ({ value: s.id, label: `${s.symbol} ${s.name}` }))]} />
        <DateField label="除息／除權日" value={exDate} onChange={setExDate} />
        <DateField label="發放日" value={payDate} onChange={setPayDate} />
        <AmountField label={kind === 'cash' ? '每股現金' : '每股配股數'} value={perShare} onChange={setPerShare} placeholder={kind === 'cash' ? '例：2.5' : '例：0.05（每股配 0.05 股）'} />
        <AmountField label="持有股數" value={shares} onChange={setShares} />
        {kind === 'cash' && (
          <>
            <div className="field"><span className="label">股利總額</span><span className="row-main num" style={{ textAlign: 'right' }}>{formatMoney(gross, cur)}</span></div>
            <AmountField label="預扣稅款" value={withholding} onChange={setWithholding} currency={cur} />
            {cur === 'TWD' && <AmountField label="二代健保" value={nhi} onChange={setNhi} currency={cur} />}
            <AmountField label="匯費" value={fee} onChange={setFee} currency={cur} />
            <div className="field"><span className="label">實收淨額</span><b className="row-main num pos" style={{ textAlign: 'right' }}>{formatMoney(net, cur)}</b></div>
          </>
        )}
        <SelectField label="狀態" value={status} onChange={setStatus} options={[{ value: 'paid', label: '已發放' }, { value: 'announced', label: '已公告，尚未發放' }]} />
        {kind === 'cash' && <AccountField label="入帳帳戶" value={accountId} onChange={setAccountId} accounts={accounts.list} />}
        {kind === 'cash' && <SwitchField label="自動入帳（產生收入帳目）" checked={sync} onChange={setSync} />}
      </div>
      {kind === 'stock' && shares && perShare && (
        <p className="muted">將配發 {new Decimal(shares || 0).mul(perShare || 0).floor().toString()} 股（不足一股的部分通常以現金發放）。</p>
      )}
      <button className="btn" onClick={() => void save()}>儲存</button>
      {dividend && (
        <button className="btn danger" style={{ marginTop: 10 }} onClick={async () => { if (window.confirm('刪除這筆股利？相關的入帳帳目或配股也會移除。')) { await deleteDividend(dividend.id); onClose(); } }}>刪除</button>
      )}
    </>
  );
}

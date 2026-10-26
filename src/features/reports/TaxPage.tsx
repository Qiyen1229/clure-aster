/**
 * 投資稅務彙總（報稅參考）：國內股利合併／分開計稅比較、二代健保、海外所得與最低稅負（基本稅額）估算。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { DEFAULT_TAX_PARAMS, summarizeTax } from '@/domain/tax';
import { investIncomeForYear } from '@/services/tax';
import { useSettings } from '@/stores/settings';
import { Segmented, SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';

const fmt = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('zh-TW')}`;

export default function TaxPage() {
  const navigate = useNavigate();
  const base = useSettings((s) => s.baseCurrency);
  const method = useSettings((s) => s.invest.costMethod);
  const tax = useSettings((s) => s.tax);
  const set = useSettings((s) => s.set);
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(String(thisYear - (new Date().getMonth() < 5 ? 1 : 0)));
  const data = useLiveQuery(() => investIncomeForYear(year, base, method), [year, base, method]);
  const sum = data ? summarizeTax(data.income, { ...DEFAULT_TAX_PARAMS, netIncome: tax.netIncome }) : null;

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>稅務彙總</h1>
        <button className="icon-btn" aria-label="列印" onClick={() => window.print()}><Icon name="download" /></button>
      </header>
      <div style={{ marginBottom: 12 }}>
        <Segmented value={year} onChange={setYear} ariaLabel="所得年度"
          options={[thisYear - 2, thisYear - 1, thisYear].map((y) => ({ value: String(y), label: `${y}（${y - 1911}年度）` }))} />
      </div>
      {base !== 'TWD' && <p className="card" style={{ fontSize: '0.85rem' }}>⚠️ 主幣別不是新台幣，金額以 {base} 計算，與台灣稅務級距比較時請自行換算。</p>}
      {!data || !sum ? <SkeletonRows n={4} /> : (
        <>
          <div className="list">
            <div className="field">
              <label htmlFor="tax-net">綜合所得淨額</label>
              <input id="tax-net" type="number" inputMode="numeric" className="num" value={tax.netIncome || ''} placeholder="不含股利，例如 800000"
                onChange={(e) => set('tax', { ...tax, netIncome: Math.max(0, Number(e.target.value) || 0) })} />
            </div>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', margin: '-4px 8px 12px' }}>薪資等所得扣除免稅額、扣除額後的金額（不含股利）。用來判斷邊際稅率與基本稅額；不填則以 0 估算。</p>

          <div className="section-title">國內股利（{fmt(data.income.domesticDividend)}）</div>
          <section className="card">
            <div className="stat-grid">
              <div className="stat"><div className="k">合併計稅</div><div className="v num">{fmt(sum.combined.net)}</div></div>
              <div className="stat"><div className="k">分開計稅 28%</div><div className="v num">{fmt(sum.separate.tax)}</div></div>
              <div className="stat"><div className="k">二代健保（已扣）</div><div className="v num">{fmt(data.income.nhi)}</div></div>
            </div>
            {data.income.domesticDividend > 0 && (
              <p style={{ fontSize: '0.88rem', margin: '10px 0 0' }}>
                建議 <b>{sum.better === 'combined' ? '合併計稅' : '分開計稅'}</b>，約可少繳 {fmt(sum.saving)}。
                合併計稅：股利增加稅額 {fmt(sum.combined.tax)} − 可抵減 {fmt(sum.combined.credit)}（8.5%，上限 8 萬）{sum.combined.net < 0 ? '，可退稅' : ''}。
              </p>
            )}
          </section>

          <div className="section-title">海外所得（美股、港股）</div>
          <section className="card">
            <div className="stat-grid">
              <div className="stat"><div className="k">股利毛額</div><div className="v num">{fmt(data.income.foreignDividend)}</div></div>
              <div className="stat"><div className="k">已實現損益</div><div className="v num">{fmt(data.income.foreignRealized)}</div></div>
              <div className="stat"><div className="k">國外已扣繳</div><div className="v num">{fmt(data.income.foreignWithholding)}</div></div>
            </div>
            <p style={{ fontSize: '0.88rem', margin: '10px 0 0' }}>
              海外所得合計 <b>{fmt(sum.overseasIncome)}</b>{sum.overseasIncluded
                ? `，已達 100 萬，需計入基本所得額（${fmt(sum.basicIncome)}）。基本稅額約 ${fmt(sum.basicTax)}，一般所得稅額約 ${fmt(sum.regularTax)}${sum.amtDue > 0 ? `，預估需補繳 ${fmt(sum.amtDue)}（已扣除國外已繳稅額）` : '，不需補繳'}。`
                : '，未達 100 萬元，免計入基本所得額（仍需在申報時填報海外所得）。'}
            </p>
          </section>

          {data.income.domesticRealized !== 0 && (
            <p className="muted" style={{ fontSize: '0.82rem', margin: '0 8px 12px' }}>國內證券交易損益 {fmt(data.income.domesticRealized)}：證所稅停徵中，不需申報（證交稅已於賣出時扣繳）。</p>
          )}

          {data.rows.length > 0 && (
            <>
              <div className="section-title">明細</div>
              <div className="list">
                {data.rows.map((r) => (
                  <div key={r.stockId} className="row">
                    <div className="row-main">
                      <div className="row-title">{r.symbol} {r.name}</div>
                      <div className="row-sub">{r.market}{r.withholding ? ` · 扣繳 ${fmt(r.withholding)}` : ''}{r.nhi ? ` · 健保 ${fmt(r.nhi)}` : ''}</div>
                    </div>
                    <span className="num" style={{ textAlign: 'right', fontSize: '0.88rem' }}>股利 {fmt(r.dividend)}<br /><span className="muted">損益 {fmt(r.realized)}</span></span>
                  </div>
                ))}
              </div>
            </>
          )}
          <p className="disclaimer">以 App 內的股利與交易紀錄估算，級距、免稅額採 113 年度（114 年 5 月申報）標準；實際以財政部公告與綜所稅申報系統為準。</p>
        </>
      )}
    </main>
  );
}

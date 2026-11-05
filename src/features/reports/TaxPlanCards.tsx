/**
 * 稅務規劃卡片（放在稅務彙總頁最上面）：
 *  📅 除息前預警：即將除息的持股，一句話行動建議（會不會被扣二代健保、參與除息還是除息前賣出買回），可展開看數字
 *  🌏 海外所得控管：離 100 萬門檻與基本稅額多遠、年底前實現虧損有沒有幫助
 * 全部在本機規則運算，不用 AI。
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { adviceOf, overseasAdvice, sharesText, type DivAnalysis } from '@/domain/taxplan';
import { loadTaxPlan } from '@/services/taxplan';

const n = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('zh-TW')}`;
const md = (d: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : '—');
const TONE = { ok: 'var(--success)', warn: 'var(--warning)', info: 'var(--accent-text)' } as const;

function EventCard({ a }: { a: DivAnalysis }) {
  const [open, setOpen] = useState(false);
  const e = a.event;
  const adv = adviceOf(a);
  return (
    <section className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '2px 8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b>{e.symbol} {e.name}</b>
        <span className="row-sub">{e.source === 'estimated' ? '推估' : '已公告'}・除息 {md(e.exDate)}・發放 {md(e.payDate)}</span>
      </div>
      <p style={{ margin: '8px 0 6px', fontSize: '0.92rem', lineHeight: 1.55, whiteSpace: 'normal' }}>
        <span style={{ color: TONE[adv.tone], fontWeight: 700 }}>{a.recommendation === 'consider_skip' ? '可以評估　' : a.nhi ? '留意　' : '建議　'}</span>{adv.headline}
      </p>
      <button className="attn-link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? '收起數字' : '看計算數字'}</button>
      {open && (
        <div className="list" style={{ marginTop: 6 }}>
          <div className="row"><span className="row-main">持股／每股股利</span><span className="num">{sharesText(e.shares)} × {e.perShare}</span></div>
          <div className="row"><span className="row-main">預計配息（毛額）</span><span className="num">{n(e.gross)}</span></div>
          <div className="row"><span className="row-main">二代健保（單次 ≥ 2 萬扣 2.11%）</span><span className="num">{n(a.nhi)}</span></div>
          <div className="row"><span className="row-main">所得稅變化（{a.method === 'combined' ? '合併計稅' : '分開計稅'}，負數＝退稅）</span><span className="num">{n(a.incTax)}</span></div>
          <div className="row"><span className="row-main">這筆之前，8.5% 抵減額度還剩</span><span className="num">{n(a.creditRemainingBefore)}</span></div>
          <div className="row"><span className="row-main"><b>參與除息，實拿</b></span><span className="num"><b>{n(a.joinNet)}</b></span></div>
          {a.skipCosts !== null && a.skipAdvantage !== null && (
            <>
              <div className="row"><span className="row-main">棄息：賣出＋買回的手續費與證交稅</span><span className="num">{n(a.skipCosts)}</span></div>
              <div className="row"><span className="row-main">棄息比參與多保留（已扣成本）</span><span className="num" style={{ color: a.skipAdvantage > 0 ? 'var(--success)' : 'var(--danger)' }}>{n(a.skipAdvantage)}</span></div>
              <div className="row"><span className="row-main">股價波動風險緩衝（持股市值 0.5%）</span><span className="num">{n(a.riskBuffer ?? 0)}</span></div>
              {a.breakEvenPerShare !== null && a.skipAdvantage > 0 && (
                <p className="row-sub" style={{ margin: '6px 12px', whiteSpace: 'normal' }}>損益兩平：買回價只要不超過「賣出價 − 每股股利 + {a.breakEvenPerShare.toFixed(2)} 元」就划算；超過就反而虧。</p>
              )}
            </>
          )}
          {a.skipAdvantage === null && <p className="row-sub" style={{ margin: '6px 12px', whiteSpace: 'normal' }}>沒有這檔的報價，無法估算除息前賣出再買回。</p>}
        </div>
      )}
    </section>
  );
}

export function TaxPlanCards() {
  const plan = useLiveQuery(() => loadTaxPlan(), []);
  if (!plan) return null;
  const ow = plan.overseas;
  const oadv = ow ? overseasAdvice(ow) : null;
  return (
    <>
      <div className="section-title">📅 除息前預警（未來 4 個月）</div>
      {!plan.netIncomeSet && <p className="row-sub" style={{ margin: '0 8px 8px', whiteSpace: 'normal' }}>你還沒填下面的「綜合所得淨額」，目前以 0 估算（邊際稅率 5%）；填了之後建議會更準。</p>}
      {plan.events.length === 0 ? (
        <section className="card"><p style={{ margin: 0, whiteSpace: 'normal' }}>近期沒有持股要除息。公告或有去年的配息紀錄時，這裡會提早告訴你會不會被扣二代健保，以及要不要參與除息。</p></section>
      ) : plan.events.map((a) => <EventCard key={`${a.event.stockId}:${a.event.exDate ?? a.event.payDate}`} a={a} />)}
      {ow && oadv && (
        <>
          <div className="section-title">🌏 海外所得控管（{plan.year} 年）</div>
          <section className="card">
            <div className="stat-grid">
              <div className="stat"><div className="k">海外所得（股利＋獲利）</div><div className="v num">{n(ow.income)}</div></div>
              <div className="stat"><div className="k">距 100 萬門檻</div><div className="v num" style={{ color: ow.remaining < 0 ? 'var(--danger)' : undefined }}>{ow.remaining < 0 ? `超過 ${n(-ow.remaining)}` : n(ow.remaining)}</div></div>
              <div className="stat"><div className="k">預估補繳基本稅額</div><div className="v num">{n(ow.amtDue)}</div></div>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-3)', margin: '10px 0 8px', overflow: 'hidden' }} role="img" aria-label={`海外所得達門檻的 ${Math.round(ow.pct)}%`}>
              <div style={{ width: `${Math.min(100, ow.pct)}%`, height: '100%', background: ow.level === 'over' ? 'var(--danger)' : ow.level === 'near' ? 'var(--warning)' : 'var(--success)' }} />
            </div>
            <p style={{ margin: 0, fontSize: '0.92rem', lineHeight: 1.55, whiteSpace: 'normal', color: TONE[oadv.tone] }}>{oadv.headline}</p>
          </section>
        </>
      )}
      <p className="disclaimer">除息與棄息試算依你的持股、股利紀錄、報價與費稅設定估算，不含價格波動與稅法變動，僅供參考，不構成投資或稅務建議；實際以財政部公告與申報系統為準。</p>
    </>
  );
}

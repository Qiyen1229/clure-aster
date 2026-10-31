/**
 * 統一發票對獎：每期開獎後自動拿帳目上的發票號碼去對，中獎就放煙火，並可一鍵記成「中獎」收入。
 * 也能手動輸入發票末 8 碼（紙本發票沒記帳時）、補上財政部另行公布的增開六獎。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { PrizeDraw } from '@/domain/invoice-prize';
import { PRIZE_INFO } from '@/domain/invoice-prize';
import { checkNumber, checkPeriod, claimPrize, loadDraws, setExtraSixth, type PeriodResult, type PrizeEntry } from '@/services/invoicePrize';
import { useUI } from '@/stores/ui';
import { Amount, EmptyState, SkeletonRows } from '@/ui/controls';
import { Fireworks } from '@/ui/Fireworks';
import { Icon } from '@/ui/Icon';

const CLAIM_STATE = { before: '尚未開始領獎', open: '領獎中', over: '已過領獎期限' } as const;

export default function InvoicePrizePage() {
  const navigate = useNavigate();
  const snack = (text: string, duration?: number) => useUI.getState().showSnack({ text, duration });
  const [draws, setDraws] = useState<PrizeDraw[] | null>(null);
  const [err, setErr] = useState('');
  const [period, setPeriod] = useState('');
  const [boom, setBoom] = useState(false);
  const [manual, setManual] = useState('');
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = useState(() => new Set<string>())[0];

  const refresh = async (force = false) => {
    setErr('');
    try {
      const d = await loadDraws({ force });
      setDraws(d);
      setPeriod((p) => p || d[0]?.period || '');
    } catch (e) { setErr(`抓不到中獎號碼：${(e as Error).message}。請確認報價代理有在執行（財政部 RSS 也是走同一個代理）。`); setDraws([]); }
  };
  useEffect(() => { void refresh(); }, []);

  const draw = draws?.find((d) => d.period === period);
  // 帳目有變動（記入中獎收入、新增發票）就重新對
  const txVersion = useLiveQuery(() => db.transactions.count(), []);
  const result = useLiveQuery<PeriodResult | null>(() => (draw ? checkPeriod(draw) : Promise.resolve(null)), [draw, txVersion]);

  useEffect(() => { setExtra(draw?.extraSixth.join('、') ?? ''); }, [draw?.period]); // eslint-disable-line react-hooks/exhaustive-deps
  // 這一期有還沒記入的中獎發票：每一期只放一次煙火
  useEffect(() => {
    if (result && result.unclaimedMinor > 0 && !shown.has(result.draw.period)) { shown.add(result.draw.period); setBoom(true); }
  }, [result, shown]);

  const manualHit = useMemo(() => (draw && manual.replace(/\D/g, '').length >= 8 ? checkNumber(manual, draw) : undefined), [draw, manual]);
  const manualReady = manual.replace(/\D/g, '').length >= 8;

  const claim = async (e: PrizeEntry) => {
    setBusy(true);
    try { await claimPrize(e); snack(`已記入中獎收入 $${e.hit!.amount.toLocaleString()}`); }
    catch (er) { snack((er as Error).message, 6000); }
    finally { setBusy(false); }
  };

  return (
    <main className="page">
      <Fireworks play={boom} onDone={() => setBoom(false)} />
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>統一發票對獎</h1>
        <button className="icon-btn" aria-label="重新取得中獎號碼" onClick={() => void refresh(true)}><Icon name="repeat" /></button>
      </header>

      {!draws ? <SkeletonRows n={4} /> : err ? (
        <EmptyState emoji="🧾" title="暫時對不了獎" text={err} action={<button className="btn small" onClick={() => void refresh(true)}>再試一次</button>} />
      ) : (
        <>
          <div className="prize-periods" role="tablist" aria-label="期別">
            {draws.slice(0, 6).map((d) => (
              <button key={d.period} role="tab" aria-selected={d.period === period} className={`prize-chip${d.period === period ? ' on' : ''}`} onClick={() => setPeriod(d.period)}>
                {Number(d.period.slice(0, 4)) - 1911}年{d.period.slice(5)}~{String(Number(d.period.slice(5)) + 1).padStart(2, '0')}月
              </button>
            ))}
          </div>

          {draw && (
            <>
              <section className={`card glass prize-hero${result && result.winners.length ? ' won' : ''}`} aria-live="polite">
                {!result ? <SkeletonRows n={2} /> : result.winners.length ? (
                  <>
                    <div className="prize-emoji" aria-hidden="true">🎉</div>
                    <div className="muted">{draw.label}　中了 {result.winners.length} 張</div>
                    <div className="hero-num num"><Amount minor={result.totalMinor} currency="TWD" tone="none" /></div>
                    {result.unclaimedMinor > 0 && <div className="muted">還有 <Amount minor={result.unclaimedMinor} currency="TWD" tone="none" /> 尚未記入收入</div>}
                  </>
                ) : (
                  <>
                    <div className="prize-emoji" aria-hidden="true">{result.checked ? '🍀' : '🧾'}</div>
                    <div className="row-title">{result.checked ? `這一期對了 ${result.checked} 張發票，沒有中獎` : '這一期沒有帶發票號碼的帳目'}</div>
                    <div className="muted">{result.checked ? '下一期加油！' : '用手機條碼載具、掃描紙本發票 QR Code 或匯入明細記帳，就會自動對獎。'}</div>
                  </>
                )}
                {result && <div className="muted prize-sub">開獎 {result.schedule.drawDate}・領獎 {result.schedule.claimFrom} ～ {result.schedule.claimTo}（{CLAIM_STATE[result.claimState]}）</div>}
              </section>

              {result && result.winners.length > 0 && (
                <>
                  <div className="section-title">中獎的發票</div>
                  <div className="list">
                    {result.winners.map((w) => (
                      <div key={w.number} className="row">
                        <div className="row-main">
                          <div className="row-title">{w.hit!.name}　<span className="num">${w.hit!.amount.toLocaleString()}</span></div>
                          <div className="row-sub">{w.number}・{w.tx.date}{w.tx.merchant ? `・${w.tx.merchant}` : ''}</div>
                        </div>
                        {w.claimed ? <span className="muted">已記入</span> : (
                          <button className="btn small" disabled={busy} onClick={() => void claim(w)}>記入中獎收入</button>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="muted prize-note">請持中獎發票在領獎期間內，到郵局或指定銀行兌領；「記入中獎收入」只是在帳本記一筆，不會替你領獎。</p>
                </>
              )}

              <div className="section-title">這一期的中獎號碼</div>
              <div className="list">
                <div className="row"><span className="row-main">特別獎 1,000 萬</span><span className="num">{draw.special}</span></div>
                <div className="row"><span className="row-main">特獎 200 萬</span><span className="num">{draw.grand}</span></div>
                <div className="row"><div className="row-main"><div className="row-title">頭獎 20 萬</div><div className="row-sub num" style={{ whiteSpace: 'normal' }}>{draw.firsts.join('　')}</div></div></div>
                <div className="row"><span className="row-main row-sub" style={{ whiteSpace: 'normal' }}>
                  二獎 4 萬～六獎 200：與頭獎號碼末 7～3 碼相同（{(['second', 'third', 'fourth', 'fifth', 'sixth'] as const).map((k) => `${PRIZE_INFO[k].name} ${PRIZE_INFO[k].amount.toLocaleString()}`).join('、')}）
                </span></div>
              </div>

              <div className="section-title">增開六獎（財政部有公布時才需要）</div>
              <div className="list">
                <div className="field">
                  <label htmlFor="pz-extra">末 3 碼，用頓號或逗號分隔</label>
                  <input id="pz-extra" inputMode="numeric" value={extra} placeholder="例如 123、456" onChange={(e) => setExtra(e.target.value)} />
                </div>
                <button className="row accent" onClick={async () => { await setExtraSixth(draw.period, extra.match(/\d{3}/g) ?? []); await refresh(); snack('已儲存增開六獎'); }}>儲存並重新對獎</button>
              </div>

              <div className="section-title">手動對獎（沒記帳的發票）</div>
              <div className="list">
                <div className="field">
                  <label htmlFor="pz-manual">發票號碼（可只輸入末 8 碼）</label>
                  <input id="pz-manual" value={manual} autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder="AB12345678" onChange={(e) => setManual(e.target.value)} />
                </div>
                {manualReady && (
                  <div className="row"><span className="row-main">{manualHit ? `🎉 中了${manualHit.name}　$${manualHit.amount.toLocaleString()}` : '沒有中獎'}</span></div>
                )}
              </div>
              <p className="muted prize-note">雲端發票專屬獎由財政部另外通知載具使用者，這裡不含。號碼來源：財政部統一發票中獎號碼公告，結果僅供參考，以財政部公告為準。</p>
            </>
          )}
        </>
      )}
    </main>
  );
}

/**
 * 股票資料源與投資設定：代理網址／權杖（含連線測試）、自動刷新秒數、資料源優先順序、API Key、
 * 台股手續費率／折扣／最低手續費／證交稅率、成本法、預設同步記帳。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { providerById } from '@/services/quotes/providers';
import { proxied } from '@/services/quotes/http';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Segmented, Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import type { InvestSettings, QuoteSettings } from '@/db/repo/settings';

function Order({ title, value, onChange }: { title: string; value: string[]; onChange: (v: string[]) => void }) {
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const n = [...value];
    [n[i], n[j]] = [n[j], n[i]];
    onChange(n);
  };
  return (
    <>
      <div className="section-title">{title}（由上而下依序嘗試）</div>
      <div className="list">
        {value.map((id, i) => (
          <div key={id} className="row">
            <span className="num muted" style={{ width: 20 }}>{i + 1}</span>
            <span className="row-main">{providerById(id)?.label ?? id}{providerById(id)?.keyName ? <span className="row-sub">需要 API Key</span> : null}</span>
            <button className="icon-btn plain" aria-label="上移" onClick={() => move(i, -1)}><Icon name="up" size={18} /></button>
            <button className="icon-btn plain" aria-label="下移" onClick={() => move(i, 1)}><Icon name="down" size={18} /></button>
          </div>
        ))}
      </div>
    </>
  );
}

export default function InvestSettingsPage() {
  const navigate = useNavigate();
  const s = useSettings();
  const q = s.quote;
  const inv = s.invest;
  const setQ = (patch: Partial<QuoteSettings>) => s.set('quote', { ...q, ...patch });
  const setI = (patch: Partial<InvestSettings>) => s.set('invest', { ...inv, ...patch });
  const [testing, setTesting] = useState(false);

  const test = async () => {
    setTesting(true);
    try {
      const base = (q.proxyUrl || '/proxy').replace(/\/$/, '');
      const h = await fetch(`${base}/health`, { cache: 'no-store' });
      if (!h.ok) throw new Error(`health HTTP ${h.status}`);
      const { url, headers } = proxied('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
      const r = await fetch(url, { headers, cache: 'no-store' });
      if (r.status === 401) throw new Error('代理權杖錯誤');
      if (!r.ok) throw new Error(`證交所 HTTP ${r.status}`);
      const j = await r.json();
      useUI.getState().showSnack({ text: `連線成功 ✓ 取得 ${j.length} 檔台股資料` });
    } catch (e) {
      useUI.getState().showSnack({ text: `連線失敗：${(e as Error).message}` });
    } finally { setTesting(false); }
  };

  const text = (label: string, value: string, on: (v: string) => void, opts: { placeholder?: string; type?: string; mode?: 'decimal' | 'numeric' } = {}) => (
    <div className="field">
      <span className="label">{label}</span>
      <input type={opts.type ?? 'text'} value={value} placeholder={opts.placeholder} inputMode={opts.mode} autoComplete="off" spellCheck={false} onChange={(e) => on(e.target.value.trim())} />
    </div>
  );

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>股票與資料源</h1>
        <div style={{ width: 44 }} />
      </header>

      <div className="section-title">CORS 代理</div>
      <div className="list">
        {text('代理網址', q.proxyUrl, (v) => setQ({ proxyUrl: v }), { placeholder: '/proxy 或 https://xxx.workers.dev' })}
        {text('代理權杖', q.proxyToken, (v) => setQ({ proxyToken: v }), { placeholder: '未設定可留空', type: 'password' })}
        <button className="row accent" onClick={() => void test()} disabled={testing}>{testing ? '測試中…' : '測試連線'}</button>
      </div>
      <p className="muted" style={{ fontSize: '0.78rem', margin: '0 8px 8px' }}>NAS Docker 版預設 /proxy（同源，免設定）。部署在其他靜態主機時，請依 proxy/README.md 部署 Cloudflare Worker 並填入網址。</p>

      <div className="section-title">更新</div>
      <div className="list">
        <div className="field"><span className="label">盤中自動刷新</span>
          <select value={q.refreshSec} onChange={(e) => setQ({ refreshSec: Number(e.target.value) })}>
            {[0, 30, 60, 120, 300].map((n) => <option key={n} value={n}>{n ? `每 ${n} 秒` : '關閉'}</option>)}
          </select>
        </div>
      </div>

      <Order title="台股資料源" value={q.twOrder} onChange={(v) => setQ({ twOrder: v })} />
      <Order title="美股／全球資料源" value={q.usOrder} onChange={(v) => setQ({ usOrder: v })} />

      <div className="section-title">API Key（選填，免費申請）</div>
      <div className="list">
        {text('Finnhub', q.keys.finnhub, (v) => setQ({ keys: { ...q.keys, finnhub: v } }), { type: 'password', placeholder: 'finnhub.io' })}
        {text('Twelve Data', q.keys.twelvedata, (v) => setQ({ keys: { ...q.keys, twelvedata: v } }), { type: 'password', placeholder: 'twelvedata.com' })}
        {text('Alpha Vantage', q.keys.alphavantage, (v) => setQ({ keys: { ...q.keys, alphavantage: v } }), { type: 'password', placeholder: 'alphavantage.co' })}
        {text('FinMind', q.keys.finmind, (v) => setQ({ keys: { ...q.keys, finmind: v } }), { type: 'password', placeholder: 'finmindtrade.com（可提高額度）' })}
      </div>
      <p className="muted" style={{ fontSize: '0.78rem', margin: '0 8px 8px' }}>API Key 會隨設定同步到你自己的伺服器，其他裝置登入後不必重填。Finnhub／Twelve Data／Alpha Vantage 支援直接連線，Key 不會經過代理。</p>

      <div className="section-title">成本與記帳</div>
      <div className="list">
        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="row-title" style={{ marginBottom: 6 }}>成本計算方式</div>
          <Segmented value={inv.costMethod} onChange={(v) => setI({ costMethod: v })} options={[{ value: 'avg', label: '加權平均（台股習慣）' }, { value: 'fifo', label: '先進先出 FIFO' }]} ariaLabel="成本法" />
        </div>
        <div className="field"><span className="label" style={{ flex: 1 }}>交易預設同步記帳</span><Switch checked={inv.syncToLedger} onChange={(v) => setI({ syncToLedger: v })} label="預設同步記帳" /></div>
      </div>

      <div className="section-title">台股手續費與稅</div>
      <div className="list">
        {text('手續費率', inv.feeRateDec, (v) => setI({ feeRateDec: v || '0.001425' }), { mode: 'decimal' })}
        {text('券商折扣', inv.discountDec, (v) => setI({ discountDec: v || '1' }), { mode: 'decimal', placeholder: '例：0.6 = 六折' })}
        {text('最低手續費（整股）', String(inv.minFee), (v) => setI({ minFee: Number(v) || 0 }), { mode: 'numeric' })}
        {text('最低手續費（零股）', String(inv.oddLotMinFee), (v) => setI({ oddLotMinFee: Number(v) || 0 }), { mode: 'numeric' })}
        {text('證交稅（股票）', inv.taxStockDec, (v) => setI({ taxStockDec: v || '0.003' }), { mode: 'decimal' })}
        {text('證交稅（ETF）', inv.taxEtfDec, (v) => setI({ taxEtfDec: v || '0.001' }), { mode: 'decimal' })}
        {text('證交稅（債券 ETF）', inv.taxBondEtfDec, (v) => setI({ taxBondEtfDec: v || '0' }), { mode: 'decimal' })}
      </div>
      <p className="disclaimer">報價可能延遲，僅供參考，不構成投資建議。</p>
    </main>
  );
}

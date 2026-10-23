/**
 * 幣別與匯率：顯示使用中幣別對主幣別的匯率、手動覆蓋、一鍵重新整理（open.er-api.com → jsDelivr 備援）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { CURRENCIES } from '@/domain/money';
import { refreshRates, resolveRate, setManualRate } from '@/services/fx';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

export default function FxPage() {
  const navigate = useNavigate();
  const base = useSettings((s) => s.baseCurrency);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [val, setVal] = useState('');
  const [showAll, setShowAll] = useState(false);
  const data = useLiveQuery(async () => {
    const [rates, accounts, txCur, at] = await Promise.all([
      db.exchange_rates.toArray(), db.accounts.toArray(),
      db.transactions.toArray().then((x) => new Set(x.map((t) => t.currency))), db.meta.get('fxUpdatedAt'),
    ]);
    const used = new Set([...accounts.map((a) => a.currency), ...txCur, ...(await db.stocks.toArray()).map((s) => s.currency)]);
    return { map: new Map(rates.map((r) => [`${r.base}>${r.quote}`, r])), used, at: at?.value as number | undefined };
  }, []);

  const list = Object.keys(CURRENCIES).filter((c) => c !== base && (showAll || data?.used.has(c) || ['USD', 'JPY', 'EUR'].includes(c)));

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>幣別與匯率</h1>
        <button className="icon-btn" aria-label="重新整理匯率" disabled={busy} onClick={async () => {
          setBusy(true);
          try { useUI.getState().showSnack({ text: `已更新 ${await refreshRates(base)} 種匯率` }); }
          catch (e) { useUI.getState().showSnack({ text: `更新失敗：${(e as Error).message}` }); }
          finally { setBusy(false); }
        }}><Icon name="repeat" className={busy ? 'spin' : ''} /></button>
      </header>
      <p className="muted" style={{ fontSize: '0.85rem' }}>主幣別 {base}。{data?.at ? `上次自動更新：${new Date(data.at).toLocaleString('zh-TW')}` : '尚未更新'}。手動設定的匯率不會被自動更新覆蓋。</p>
      <div className="list">
        {list.map((c) => {
          const direct = data?.map.get(`${c}>${base}`);
          const r = data ? resolveRate(data.map, c, base) : null;
          return (
            <button key={c} className="row" onClick={() => { setEdit(c); setVal(r?.toSignificantDigits(8).toString() ?? ''); }}>
              <span className="num" style={{ fontWeight: 600, width: 48 }}>{c}</span>
              <span className="row-main">{CURRENCIES[c].name}{direct?.source === 'manual' && <span className="chip" style={{ marginLeft: 6 }}>手動</span>}</span>
              <span className="num">{r ? `1 ${c} = ${r.toSignificantDigits(6).toString()} ${base}` : '無資料'}</span>
            </button>
          );
        })}
      </div>
      <button className="btn secondary small" onClick={() => setShowAll((x) => !x)}>{showAll ? '只顯示使用中' : '顯示全部幣別'}</button>
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={`${edit} → ${base}`}>
        <p className="muted" style={{ marginTop: 0 }}>1 {edit} 等於多少 {base}？</p>
        <input className="input num" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value.replace(/[^0-9.]/g, ''))} autoFocus />
        <button className="btn" style={{ marginTop: 12 }} disabled={!Number(val)} onClick={async () => { await setManualRate(edit!, base, val); setEdit(null); }}>設為手動匯率</button>
        {data?.map.get(`${edit}>${base}`)?.source === 'manual' && (
          <button className="btn secondary" style={{ marginTop: 8 }} onClick={async () => { await db.exchange_rates.delete([edit!, base]); await refreshRates(base).catch(() => undefined); setEdit(null); }}>恢復自動匯率</button>
        )}
      </Sheet>
    </main>
  );
}

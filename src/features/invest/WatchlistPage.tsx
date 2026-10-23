/**
 * 觀察清單：關注但未持有的標的，即時價格與漲跌；到價提醒（站上／跌破）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { WatchItem } from '@/db/types';
import { addWatch, removeWatch, updateAlerts } from '@/db/repo/invest';
import { updateAllQuotes } from '@/services/startup';
import { useUI } from '@/stores/ui';
import { EmptyState, SkeletonRows, Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { PullToRefresh } from '@/ui/PullToRefresh';
import { Sheet } from '@/ui/Sheet';
import { SwipeRow } from '@/ui/SwipeRow';
import { StockSearch } from './StockSearch';
import { pct } from './InvestTab';

export default function WatchlistPage() {
  const navigate = useNavigate();
  const items = useLiveQuery(async () => {
    const list = await db.watchlist.orderBy('sort').toArray();
    return Promise.all(list.map(async (w) => ({ w, stock: await db.stocks.get(w.stockId), price: await db.price_cache.get(w.stockId) })));
  }, []);
  const [adding, setAdding] = useState(false);
  const [alertFor, setAlertFor] = useState<WatchItem | null>(null);

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>觀察清單</h1>
        <button className="icon-btn" aria-label="新增關注" onClick={() => setAdding(true)}><Icon name="plus" /></button>
      </header>
      <PullToRefresh onRefresh={() => updateAllQuotes()}>
        {!items ? <SkeletonRows /> : items.length === 0 ? (
          <EmptyState emoji="👀" title="觀察清單是空的" text="加入想追蹤但還沒買的股票，設定「站上／跌破」到價提醒。"
            action={<button className="btn small" onClick={() => setAdding(true)}>加入股票</button>} />
        ) : items.map(({ w, stock, price }) => stock && (
          <SwipeRow key={w.id} onTap={() => navigate(`/invest/stock/${stock.id}`)} onEdit={() => setAlertFor(w)}
            onDelete={() => void removeWatch(w.id).then(() => useUI.getState().showSnack({ text: `已移除 ${stock.name}` }))}
            onLongPress={() => setAlertFor(w)}>
            <div className="row">
              <div className="row-main">
                <div className="row-title"><b className="num">{stock.symbol}</b> {stock.name}</div>
                <div className="row-sub">{w.alerts.filter((a) => a.enabled).map((a) => `${a.op === '>=' ? '站上' : '跌破'} ${a.priceDec}`).join('、') || '無到價提醒（右滑設定）'}</div>
              </div>
              <div className="row-end">
                <div className="num" style={{ fontWeight: 600 }}>{price ? Number(price.priceDec).toLocaleString('zh-TW', { maximumFractionDigits: 4 }) : '—'}</div>
                {price && <div className={`num ${Number(price.changeDec) >= 0 ? 'pos' : 'neg'}`} style={{ fontSize: '0.8rem' }}>{pct(Number(price.changePctDec))}</div>}
              </div>
            </div>
          </SwipeRow>
        ))}
      </PullToRefresh>
      <p className="disclaimer">到價提醒在 App 開啟或報價更新時檢查。報價可能延遲，僅供參考，不構成投資建議。</p>
      <Sheet open={adding} onClose={() => setAdding(false)} title="加入觀察清單" full>
        {adding && <StockSearch onPick={async (s) => { await addWatch(s.id); setAdding(false); void updateAllQuotes({ silent: true }); }} />}
      </Sheet>
      <Sheet open={!!alertFor} onClose={() => setAlertFor(null)} title="到價提醒">
        {alertFor && <AlertEditor item={alertFor} onClose={() => setAlertFor(null)} />}
      </Sheet>
    </main>
  );
}

function AlertEditor({ item, onClose }: { item: WatchItem; onClose: () => void }) {
  const [alerts, setAlerts] = useState(item.alerts);
  const [op, setOp] = useState<'>=' | '<='>('>=');
  const [price, setPrice] = useState('');
  return (
    <>
      <div className="list">
        {alerts.length === 0 && <div className="row muted">尚未設定提醒</div>}
        {alerts.map((a, i) => (
          <div key={i} className="row">
            <span className="row-main">{a.op === '>=' ? '站上' : '跌破'} <b className="num">{a.priceDec}</b></span>
            <Switch checked={a.enabled} onChange={(v) => setAlerts(alerts.map((x, j) => (j === i ? { ...x, enabled: v, lastTriggeredAt: undefined } : x)))} label="啟用" />
            <button className="icon-btn plain" aria-label="刪除提醒" onClick={() => setAlerts(alerts.filter((_, j) => j !== i))}><Icon name="trash" size={18} /></button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select className="input" style={{ width: 100 }} value={op} onChange={(e) => setOp(e.target.value as '>=' | '<=')} aria-label="條件">
          <option value=">=">站上</option><option value="<=">跌破</option>
        </select>
        <input className="input num" inputMode="decimal" placeholder="價格" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} />
        <button className="btn small" disabled={!Number(price)} onClick={() => { setAlerts([...alerts, { op, priceDec: price, enabled: true }]); setPrice(''); }}>加入</button>
      </div>
      <button className="btn" style={{ marginTop: 16 }} onClick={async () => { await updateAlerts(item.id, alerts); onClose(); }}>儲存</button>
    </>
  );
}

/**
 * 新增／編輯投資交易：買進、賣出、配股、分割。
 * 台股：整股（張）／零股切換、手續費（折扣、最低）與證交稅自動計算（可手改）；
 * 外幣：自動帶入成交匯率；可選擇同步產生記帳帳目（扣款／入帳帳戶）。
 */
import { useEffect, useMemo, useState } from 'react';
import Decimal from 'decimal.js';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Stock, StockTrade } from '@/db/types';
import { addTrade, deleteTrade, restoreTrade, updateTrade } from '@/db/repo/invest';
import { twFee, twSellTax, twTaxRate } from '@/domain/invest/fees-tw';
import { computePosition } from '@/domain/invest/position';
import { currencyInfo, formatMoney, fromMinor, toMinor } from '@/domain/money';
import { todayKey } from '@/domain/period';
import { getRate } from '@/services/fx';
import { twFeeConfig } from '@/services/portfolio';
import { useAccounts } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI } from '@/stores/ui';
import { Segmented } from '@/ui/controls';
import { AccountField, AmountField, DateField, SwitchField, TextField } from '@/ui/form';
import { Sheet } from '@/ui/Sheet';
import { MARKET_LABEL, StockSearch } from './StockSearch';

type TType = StockTrade['type'];

export function TradeSheet({ open, onClose, stockId, trade, initialType = 'buy' }: {
  open: boolean; onClose: () => void; stockId?: string; trade?: StockTrade; initialType?: TType;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={trade ? '編輯交易' : '新增交易'} full>
      {open && <TradeForm key={trade?.id ?? stockId ?? 'new'} stockId={trade?.stockId ?? stockId} trade={trade} initialType={initialType} onClose={onClose} />}
    </Sheet>
  );
}

function TradeForm({ stockId, trade, initialType, onClose }: { stockId?: string; trade?: StockTrade; initialType: TType; onClose: () => void }) {
  const settings = useSettings();
  const inv = settings.invest;
  const accounts = useAccounts();
  const [stock, setStock] = useState<Stock | undefined>();
  const stockFromDb = useLiveQuery(() => (stockId ? db.stocks.get(stockId) : Promise.resolve(undefined as Stock | undefined)), [stockId]);
  useEffect(() => { if (stockFromDb) setStock(stockFromDb); }, [stockFromDb]);
  const trades = useLiveQuery(() => (stock ? db.stock_trades.where('stockId').equals(stock.id).toArray() : Promise.resolve([] as StockTrade[])), [stock?.id]) ?? [];

  const isTW = stock ? stock.currency === 'TWD' && stock.market !== 'US' && stock.market !== 'HK' : true;
  const lot = stock?.lotSize ?? 1000;
  const brokerages = accounts.list.filter((a) => a.type === 'brokerage');
  const [type, setType] = useState<TType>(trade?.type ?? initialType);
  const [date, setDate] = useState(trade?.date ?? todayKey());
  const [price, setPrice] = useState(trade?.priceDec && trade.type !== 'split' ? trade.priceDec : '');
  const initLots = trade && isTW && new Decimal(trade.sharesDec).mod(lot).isZero() && trade.type !== 'split';
  const [unit, setUnit] = useState<'lot' | 'share'>(trade ? (initLots ? 'lot' : 'share') : 'lot');
  const [qty, setQty] = useState(trade ? (initLots ? new Decimal(trade.sharesDec).div(lot).toString() : trade.sharesDec) : '');
  const [fee, setFee] = useState(trade ? fromMinor(trade.feeMinor, 'TWD').toString() : '');
  const [tax, setTax] = useState(trade ? fromMinor(trade.taxMinor, 'TWD').toString() : '');
  const [feeEdited, setFeeEdited] = useState(!!trade);
  const [fx, setFx] = useState(trade?.fxRateDec ?? '');
  const [isDCA, setDCA] = useState(trade?.isDCA ?? false);
  const [accountId, setAccountId] = useState(trade?.accountId ?? (inv.defaultBrokerageId || brokerages[0]?.id || ''));
  const brokerage = accounts.map.get(accountId);
  const [sync, setSync] = useState(trade?.syncToLedger ?? inv.syncToLedger);
  const [cashAccountId, setCashAccountId] = useState(trade?.cashAccountId ?? brokerage?.brokerage?.settlementAccountId ?? accountId);
  const [note, setNote] = useState(trade?.note ?? '');

  // 帳戶清單載入後補上預設證券戶與扣款帳戶
  useEffect(() => {
    if (trade || !accounts.list.length) return;
    const bk = accountId ? accounts.map.get(accountId) : accounts.list.find((a) => a.id === inv.defaultBrokerageId) ?? accounts.list.find((a) => a.type === 'brokerage');
    if (!accountId && bk) setAccountId(bk.id);
    if (!cashAccountId || !accounts.map.has(cashAccountId)) setCashAccountId(bk?.brokerage?.settlementAccountId ?? bk?.id ?? accounts.list[0].id);
  }, [accounts.list.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const effectiveUnit = isTW && type !== 'split' ? unit : 'share';
  const shares = useMemo(() => {
    try { return qty ? (effectiveUnit === 'lot' ? new Decimal(qty).mul(lot) : new Decimal(qty)) : new Decimal(0); } catch { return new Decimal(0); }
  }, [qty, effectiveUnit, lot]);
  const cur = stock?.currency ?? 'TWD';

  // 匯率：外幣標的自動帶入成交當下匯率（標的幣別 → 主幣別）
  useEffect(() => {
    if (!stock || fx || cur === settings.baseCurrency) return;
    getRate(cur, settings.baseCurrency).then((r) => r && setFx(r.toSignificantDigits(8).toString()));
  }, [stock, cur]); // eslint-disable-line react-hooks/exhaustive-deps

  // 台股費稅自動計算（使用者手改後不再覆蓋）
  useEffect(() => {
    if (!stock || feeEdited || !isTW) return;
    if ((type === 'buy' || type === 'sell') && price && shares.gt(0)) {
      const cfg = twFeeConfig(inv);
      setFee(String(twFee(price, shares, cfg, lot) / 100));
      setTax(type === 'sell' ? String(twSellTax(price, shares, twTaxRate(stock.assetType, cfg, stock.taxRateDec)) / 100) : '0');
    } else { setFee('0'); setTax('0'); }
  }, [price, shares, type, stock, feeEdited]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = useMemo(() => computePosition(trades.filter((t) => t.id !== trade?.id), inv.costMethod, currencyInfo(cur).exp), [trades, trade?.id, inv.costMethod, cur]);
  const gross = price && shares.gt(0) ? new Decimal(price).mul(shares) : new Decimal(0);
  const feeD = new Decimal(fee || 0), taxD = new Decimal(tax || 0);
  const total = type === 'buy' ? gross.plus(feeD) : gross.minus(feeD).minus(taxD);
  const estPnl = type === 'sell' && pos.shares.gt(0) && shares.gt(0)
    ? total.minus(new Decimal(pos.costMinor).div(Decimal.pow(10, currencyInfo(cur).exp)).mul(Decimal.min(shares, pos.shares)).div(pos.shares)) : null;

  if (!stock) {
    return (
      <>
        <p className="muted" style={{ marginTop: 0 }}>先選擇要交易的標的</p>
        <StockSearch onPick={setStock} />
      </>
    );
  }

  const save = async () => {
    if (shares.lte(0)) return useUI.getState().showSnack({ text: type === 'split' ? '請輸入分割倍數' : '請輸入股數' });
    if ((type === 'buy' || type === 'sell') && (!price || new Decimal(price).lte(0))) return useUI.getState().showSnack({ text: '請輸入成交價' });
    if (type === 'sell' && shares.gt(pos.shares)) {
      if (!window.confirm(`賣出 ${shares} 股超過目前持有的 ${pos.shares} 股，確定要儲存？`)) return;
    }
    if (sync && (type === 'buy' || type === 'sell') && !cashAccountId) return useUI.getState().showSnack({ text: '請選擇扣款／入帳帳戶，或關閉同步記帳' });
    const input = {
      stockId: stock.id, accountId, type, date, ts: new Date(`${date}T${new Date().toTimeString().slice(0, 8)}`).getTime(),
      sharesDec: shares.toString(), priceDec: type === 'buy' || type === 'sell' ? new Decimal(price).toString() : '0',
      feeMinor: toMinor(feeD, cur), taxMinor: toMinor(taxD, cur), fxRateDec: cur === settings.baseCurrency ? '1' : fx || '1',
      isDCA, syncToLedger: sync && (type === 'buy' || type === 'sell'), cashAccountId: sync ? cashAccountId : undefined, note,
      costMethodSnapshot: inv.costMethod,
    };
    try {
      if (trade) {
        await updateTrade(trade.id, input);
        useUI.getState().showSnack({ text: '已更新交易' });
      } else {
        const t = await addTrade(input);
        snackUndo(`已記錄${type === 'buy' ? '買進' : type === 'sell' ? '賣出' : type === 'stock_dividend' ? '配股' : '分割'} ${stock.name}`, () => deleteTrade(t.id));
      }
      if (accountId && accountId !== inv.defaultBrokerageId) settings.set('invest', { ...inv, defaultBrokerageId: accountId });
      onClose();
    } catch (e) {
      useUI.getState().showSnack({ text: `儲存失敗：${(e as Error).message}` });
    }
  };

  return (
    <>
      <div className="card glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12 }}>
        <span className="num" style={{ fontWeight: 700, fontSize: '1.1rem' }}>{stock.symbol}</span>
        <div className="row-main">
          <div className="row-title">{stock.name}</div>
          <div className="row-sub">{MARKET_LABEL[stock.market]} · {cur}{pos.shares.gt(0) ? ` · 持有 ${pos.shares.toString()} 股` : ''}</div>
        </div>
        {!trade && !stockId && <button className="btn small secondary" onClick={() => setStock(undefined)}>更換</button>}
      </div>
      <Segmented value={type} onChange={(v) => { setType(v); setFeeEdited(false); }} ariaLabel="交易類型"
        options={[{ value: 'buy', label: '買進' }, { value: 'sell', label: '賣出' }, { value: 'stock_dividend', label: '配股' }, { value: 'split', label: '分割' }]} />
      <div className="list" style={{ marginTop: 12 }}>
        <DateField label="日期" value={date} onChange={setDate} max={todayKey()} />
        {(type === 'buy' || type === 'sell') && <AmountField label="成交價" value={price} onChange={(v) => { setPrice(v); }} currency={cur} />}
        {isTW && type !== 'split' && (
          <div className="field"><span className="label">單位</span>
            <div style={{ flex: 1 }}><Segmented value={unit} onChange={setUnit} options={[{ value: 'lot', label: '整股（張）' }, { value: 'share', label: '零股（股）' }]} ariaLabel="單位" /></div>
          </div>
        )}
        <AmountField label={type === 'split' ? '分割倍數' : effectiveUnit === 'lot' ? '張數' : '股數'} value={qty} onChange={setQty} placeholder={type === 'split' ? '例：4（1 拆 4）' : '0'} />
        {(type === 'buy' || type === 'sell') && (
          <>
            <AmountField label="手續費" value={fee} onChange={(v) => { setFee(v); setFeeEdited(true); }} currency={cur} />
            {type === 'sell' && <AmountField label={isTW ? '證交稅' : '交易稅費'} value={tax} onChange={(v) => { setTax(v); setFeeEdited(true); }} currency={cur} />}
            {cur !== settings.baseCurrency && <AmountField label={`匯率 ${cur}→${settings.baseCurrency}`} value={fx} onChange={setFx} placeholder="取得中…" />}
          </>
        )}
        {type === 'buy' && <SwitchField label="定期定額" checked={isDCA} onChange={setDCA} />}
        <AccountField label="證券戶" value={accountId} onChange={(id) => { setAccountId(id); const a = accounts.map.get(id); setCashAccountId(a?.brokerage?.settlementAccountId ?? id); }}
          accounts={accounts.list} allowEmpty emptyLabel="（未指定）" filter={(a) => a.type === 'brokerage' || a.id === accountId} />
        <TextField label="備註" value={note} onChange={setNote} />
      </div>
      {(type === 'buy' || type === 'sell') && (
        <>
          <div className="list">
            <SwitchField label="同步記帳" sub={type === 'buy' ? '從帳戶扣除成交金額，手續費記為支出' : '成交金額入帳，費稅記為支出'} checked={sync} onChange={setSync} />
            {sync && <AccountField label={type === 'buy' ? '扣款帳戶' : '入帳帳戶'} value={cashAccountId} onChange={setCashAccountId} accounts={accounts.list} filter={(a) => !a.isLiability || a.type === 'credit'} />}
          </div>
          {gross.gt(0) && (
            <div className="card" style={{ fontSize: '0.9rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">成交金額</span><span className="num">{formatMoney(toMinor(gross, cur), cur)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">手續費{type === 'sell' ? '＋稅' : ''}</span><span className="num">{formatMoney(toMinor(feeD.plus(type === 'sell' ? taxD : 0), cur), cur)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: 4 }}><span>{type === 'buy' ? '應付' : '應收'}</span><span className="num">{formatMoney(toMinor(total, cur), cur)}</span></div>
              {estPnl && <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}><span className="muted">預估已實現損益（{inv.costMethod === 'avg' ? '加權平均' : 'FIFO'}）</span><b className={`num ${estPnl.gte(0) ? 'pos' : 'neg'}`}>{formatMoney(toMinor(estPnl, cur), cur, { sign: 'always' })}</b></div>}
            </div>
          )}
        </>
      )}
      <button className="btn" onClick={() => void save()}>儲存</button>
      {trade && (
        <button className="btn danger" style={{ marginTop: 10 }} onClick={async () => {
          await deleteTrade(trade.id);
          snackUndo('已刪除交易', () => restoreTrade(trade.id));
          onClose();
        }}>刪除交易</button>
      )}
      <p className="disclaimer">台股手續費依「設定 → 股票」的費率與折扣計算，實際以券商對帳單為準。</p>
    </>
  );
}

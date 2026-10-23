/**
 * 投資資料存取：標的、交易（買／賣／配股／分割）、股利、觀察清單。
 *
 * 與記帳整合（可在每筆交易關閉）：
 * - 買進：從現金帳戶扣「成交金額」（分類：股票買進，不計入收支統計）＋「手續費」另記一筆支出（計入統計）
 * - 賣出：現金帳戶入「成交金額」（分類：股票賣出，不計入統計）＋「手續費＋證交稅」另記一筆支出
 * - 現金股利：入帳到指定帳戶（分類：股利，計入收入）
 * 投資市值在淨資產中另外計算，因此買股不會讓淨資產憑空減少。
 */
import Decimal from 'decimal.js';
import { db, uid } from '../schema';
import type { Dividend, Stock, StockTrade, WatchItem } from '../types';
import { addTransaction, deleteTransactions, restoreTransactions } from './ledger';
import { currencyInfo, toMinor } from '@/domain/money';
import type { StockMeta } from '@/services/quotes/search';
import { getSetting } from './settings';

const now = () => Date.now();

export async function ensureStock(meta: StockMeta): Promise<Stock> {
  const exist = await db.stocks.where('[market+symbol]').equals([meta.market, meta.symbol]).first();
  if (exist) {
    if (!exist.industry && meta.industry) await db.stocks.update(exist.id, { industry: meta.industry });
    return exist;
  }
  const s: Stock = {
    id: uid(), market: meta.market, symbol: meta.symbol, name: meta.name, currency: meta.currency, assetType: meta.assetType,
    industry: meta.industry, lotSize: meta.market === 'US' || meta.market === 'HK' ? 1 : 1000, createdAt: now(), updatedAt: now(),
  };
  await db.stocks.add(s);
  return s;
}

export type TradeInput = Omit<StockTrade, 'id' | 'createdAt' | 'updatedAt' | 'transactionId' | 'feeTransactionId' | 'realizedPnlMinor'>;

/** 由交易產生記帳帳目（回傳帳目 id） */
async function ledgerFor(t: TradeInput & { id: string }, stock: Stock) {
  if (!t.syncToLedger || !t.cashAccountId || (t.type !== 'buy' && t.type !== 'sell')) return {};
  const acc = await db.accounts.get(t.cashAccountId);
  if (!acc) return {};
  const gross = toMinor(new Decimal(t.priceDec).mul(t.sharesDec), stock.currency);
  // 交割帳戶為主幣別且標的為外幣時，使用成交當下匯率入帳；其他情況交給匯率表
  const baseCur = await getSetting('baseCurrency');
  const fx = acc.currency !== stock.currency && acc.currency === baseCur && t.fxRateDec && t.fxRateDec !== '1' ? t.fxRateDec : undefined;
  const base = { accountId: acc.id, currency: stock.currency, fxRateDec: fx, date: t.date, ts: t.ts, stockTradeId: t.id };
  const label = `${stock.name}（${stock.symbol}）${t.type === 'buy' ? '買進' : '賣出'} ${new Decimal(t.sharesDec).toString()} 股 @ ${t.priceDec}`;
  const main = await addTransaction({
    ...base, type: t.type === 'buy' ? 'expense' : 'income', categoryId: t.type === 'buy' ? 'sys-stock-buy' : 'sys-stock-sell',
    amountMinor: gross, note: label, excludeFromStats: true, excludeFromBudget: true,
  });
  let feeId: string | undefined;
  const cost = t.feeMinor + t.taxMinor;
  if (cost > 0) {
    const fee = await addTransaction({
      ...base, type: 'expense', categoryId: 'exp-investment_exp-stock_fee', amountMinor: cost,
      note: `${stock.name} ${t.type === 'buy' ? '手續費' : '手續費＋證交稅'}`, excludeFromBudget: true,
    });
    feeId = fee.id;
  }
  return { transactionId: main.id, feeTransactionId: feeId };
}

export async function addTrade(input: TradeInput): Promise<StockTrade> {
  const stock = await db.stocks.get(input.stockId);
  if (!stock) throw new Error('標的不存在');
  const id = uid();
  const links = await ledgerFor({ ...input, id }, stock);
  const row: StockTrade = { ...input, id, ...links, createdAt: now(), updatedAt: now() };
  await db.stock_trades.add(row);
  return row;
}

export async function updateTrade(id: string, input: TradeInput): Promise<void> {
  const old = await db.stock_trades.get(id);
  if (!old) throw new Error('交易不存在');
  const stock = await db.stocks.get(input.stockId);
  if (!stock) throw new Error('標的不存在');
  await deleteTransactions([old.transactionId, old.feeTransactionId].filter(Boolean) as string[]);
  const links = await ledgerFor({ ...input, id }, stock);
  await db.stock_trades.put({ ...old, ...input, transactionId: links.transactionId, feeTransactionId: links.feeTransactionId, updatedAt: now() });
}

export async function deleteTrade(id: string): Promise<void> {
  const t = await db.stock_trades.get(id);
  if (!t) return;
  await deleteTransactions([t.transactionId, t.feeTransactionId].filter(Boolean) as string[]);
  await db.stock_trades.update(id, { deletedAt: now() });
}

export async function restoreTrade(id: string): Promise<void> {
  const t = await db.stock_trades.get(id);
  if (!t) return;
  await restoreTransactions([t.transactionId, t.feeTransactionId].filter(Boolean) as string[]);
  await db.stock_trades.update(id, { deletedAt: null });
}

// ───── 股利 ─────

export type DividendInput = Omit<Dividend, 'id' | 'createdAt' | 'updatedAt' | 'transactionId' | 'stockTradeId'> & { syncToLedger: boolean };

export async function saveDividend(input: DividendInput, id?: string): Promise<string> {
  const { syncToLedger, ...data } = input;
  const stock = await db.stocks.get(data.stockId);
  if (!stock) throw new Error('標的不存在');
  const did = id ?? uid();
  if (id) await removeDividendLinks(id);
  let transactionId: string | undefined;
  let stockTradeId: string | undefined;
  if (data.kind === 'cash' && data.status === 'paid' && syncToLedger && data.accountId && data.netMinor > 0) {
    const tx = await addTransaction({
      type: 'income', accountId: data.accountId, categoryId: 'inc-dividend', amountMinor: data.netMinor, currency: data.currency,
      date: data.payDate, ts: new Date(`${data.payDate}T09:00:00`).getTime(), note: `${stock.name}（${stock.symbol}）現金股利`, dividendId: did,
    });
    transactionId = tx.id;
  }
  if (data.kind === 'stock' && data.status === 'paid') {
    const shares = new Decimal(data.sharesHeldDec).mul(data.perShareDec).floor(); // 配股不足 1 股的部分通常以現金發放
    if (shares.gt(0)) {
      const t = await addTrade({
        stockId: stock.id, accountId: data.accountId, type: 'stock_dividend', date: data.payDate, ts: new Date(`${data.payDate}T09:00:00`).getTime(),
        sharesDec: shares.toString(), priceDec: '0', feeMinor: 0, taxMinor: 0, fxRateDec: '1', isDCA: false, syncToLedger: false, note: '股票股利',
      });
      stockTradeId = t.id;
    }
  }
  const row: Dividend = { ...data, id: did, transactionId, stockTradeId, createdAt: now(), updatedAt: now() };
  await db.dividends.put(row);
  return did;
}

async function removeDividendLinks(id: string) {
  const d = await db.dividends.get(id);
  if (!d) return;
  if (d.transactionId) await deleteTransactions([d.transactionId]);
  if (d.stockTradeId) await db.stock_trades.delete(d.stockTradeId);
}

export async function deleteDividend(id: string) {
  await removeDividendLinks(id);
  await db.dividends.delete(id);
}

/** 台股二代健保補充保費：單次股利 ≥ 20,000 元時扣 2.11% */
export function nhiSupplement(grossMinor: number, currency: string): number {
  if (currency !== 'TWD' || grossMinor < 2000000) return 0;
  return toMinor(new Decimal(grossMinor).div(100).mul('0.0211').floor(), 'TWD');
}

// ───── 觀察清單 ─────

export async function addWatch(stockId: string) {
  if (await db.watchlist.where('stockId').equals(stockId).first()) return;
  const count = await db.watchlist.count();
  const row: WatchItem = { id: uid(), stockId, sort: count, alerts: [], createdAt: now(), updatedAt: now() };
  await db.watchlist.add(row);
}

export async function removeWatch(id: string) { await db.watchlist.delete(id); }

export async function updateAlerts(id: string, alerts: WatchItem['alerts']) {
  await db.watchlist.update(id, { alerts, updatedAt: now() });
}

/** 更新報價後檢查到價提醒；同一提醒 12 小時內只通知一次 */
export async function checkPriceAlerts(): Promise<{ title: string; body: string; url: string }[]> {
  const items = await db.watchlist.toArray();
  const hits: { title: string; body: string; url: string }[] = [];
  for (const w of items) {
    const [stock, price] = await Promise.all([db.stocks.get(w.stockId), db.price_cache.get(w.stockId)]);
    if (!stock || !price) continue;
    let changed = false;
    const alerts = w.alerts.map((a) => {
      if (!a.enabled) return a;
      const p = new Decimal(price.priceDec);
      const hit = a.op === '>=' ? p.gte(a.priceDec) : p.lte(a.priceDec);
      if (hit && (!a.lastTriggeredAt || Date.now() - a.lastTriggeredAt > 12 * 3600000)) {
        changed = true;
        hits.push({
          title: `${stock.name} ${a.op === '>=' ? '站上' : '跌破'} ${a.priceDec}`,
          body: `現價 ${price.priceDec}（${Number(price.changePctDec) >= 0 ? '+' : ''}${Number(price.changePctDec).toFixed(2)}%）`,
          url: `/invest/stock/${stock.id}`,
        });
        return { ...a, lastTriggeredAt: Date.now() };
      }
      return a;
    });
    if (changed) await db.watchlist.update(w.id, { alerts });
  }
  return hits;
}

export const stockUnit = (s: Pick<Stock, 'currency'>) => Decimal.pow(10, currencyInfo(s.currency).exp);

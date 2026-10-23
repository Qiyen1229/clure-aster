/**
 * 投資組合總覽：彙整所有標的的持倉、估值、股利、XIRR，全部換算主幣別。
 * 純計算（給定資料 → 結果），由 usePortfolio hook 以 liveQuery 餵入資料。
 */
import Decimal from 'decimal.js';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Dividend, ExchangeRate, PriceCache, Stock, StockTrade } from '@/db/types';
import { computePosition, valuate, yields, type CostMethod, type Position, type Valuation } from '@/domain/invest/position';
import { xirr, type CashFlow } from '@/domain/invest/xirr';
import { convertMinor, currencyInfo, fromMinor } from '@/domain/money';
import { todayKey } from '@/domain/period';
import { resolveRate } from './fx';
import { useSettings } from '@/stores/settings';
import type { InvestSettings } from '@/db/repo/settings';
import { twFee, twSellTax, twTaxRate, type TwFeeConfig } from '@/domain/invest/fees-tw';

export interface Holding {
  stock: Stock;
  trades: StockTrade[];
  pos: Position;
  price?: PriceCache;
  val?: Valuation;
  fxNow: string;
  stale: boolean;
  dividendsBaseMinor: number;
  dividendsYearMinor: number; // 標的幣別，近 12 個月
  costYieldPct: number;
  priceYieldPct: number;
  /** 若今天全部賣出：扣除手續費與證交稅後的淨損益（標的幣別） */
  sellNowNetMinor?: number;
  xirr: number | null;
}

export interface PortfolioSummary {
  holdings: Holding[];
  closed: Holding[];
  costBase: number;
  marketValueBase: number;
  unrealizedBase: number;
  realizedBase: number;
  todayBase: number;
  dividendsBase: number;
  dividendsThisYearBase: number;
  investedBase: number; // 累計買進成本
  totalReturnPct: number;
  totalReturnWithDivPct: number;
  xirr: number | null;
  pricePnlBase: number;
  fxPnlBase: number;
  lastUpdated: number | null;
  missingPrice: number;
}

const STALE_MS = 30 * 60 * 1000;

export function buildPortfolio(params: {
  stocks: Stock[]; trades: StockTrade[]; prices: PriceCache[]; dividends: Dividend[]; rates: ExchangeRate[];
  base: string; method: CostMethod; feeEstimate: (stock: Stock, priceDec: string, sharesDec: string) => { fee: number; tax: number };
}): PortfolioSummary {
  const { stocks, trades, prices, dividends, base, method } = params;
  const rateMap = new Map(params.rates.map((r) => [`${r.base}>${r.quote}`, r]));
  const fxOf = (cur: string) => (cur === base ? '1' : resolveRate(rateMap, cur, base)?.toString() ?? '1');
  const priceMap = new Map(prices.map((p) => [p.stockId, p]));
  const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const thisYear = todayKey().slice(0, 4);

  const all: Holding[] = [];
  const flows: CashFlow[] = [];
  let investedBase = 0;
  for (const stock of stocks) {
    const st = trades.filter((t) => t.stockId === stock.id && !t.deletedAt);
    if (!st.length) continue;
    const exp = currencyInfo(stock.currency).exp;
    const pos = computePosition(st, method, exp);
    const price = priceMap.get(stock.id);
    const fxNow = fxOf(stock.currency);
    const val = price ? valuate(pos, price.priceDec, price.prevCloseDec, fxNow, exp) : undefined;
    const divs = dividends.filter((d) => d.stockId === stock.id && d.kind === 'cash' && d.status === 'paid');
    const dividendsBaseMinor = divs.reduce((a, d) => a + convertMinor(d.netMinor, d.currency, base, fxOf(d.currency)), 0);
    const dividendsYearMinor = divs.filter((d) => d.payDate >= yearAgo).reduce((a, d) => a + d.grossMinor, 0);
    // 近 12 個月每股股利（以發放時持股計）
    const dps = divs.filter((d) => d.payDate >= yearAgo).reduce((a, d) => a.plus(d.perShareDec || 0), new Decimal(0));
    const y = price ? yields(dps, pos.avgCost, price.priceDec) : { costYieldPct: 0, priceYieldPct: 0 };
    let sellNowNetMinor: number | undefined;
    if (price && pos.shares.gt(0)) {
      const { fee, tax } = params.feeEstimate(stock, price.priceDec, pos.shares.toString());
      sellNowNetMinor = val!.marketValueMinor - fee - tax - pos.costMinor;
    }
    // 現金流（主幣別）：買進為負、賣出與股利為正，期末市值為正
    const unit = Decimal.pow(10, exp);
    const hf: CashFlow[] = [];
    for (const t of st) {
      const gross = new Decimal(t.priceDec).mul(t.sharesDec).mul(unit);
      const fx = new Decimal(t.fxRateDec || 1);
      if (t.type === 'buy') {
        const v = gross.plus(t.feeMinor).mul(fx).toNumber();
        hf.push({ date: t.date, amount: -v });
        investedBase += Math.round(v);
      } else if (t.type === 'sell') {
        hf.push({ date: t.date, amount: gross.minus(t.feeMinor).minus(t.taxMinor).mul(fx).toNumber() });
      }
    }
    for (const d of divs) hf.push({ date: d.payDate, amount: convertMinor(d.netMinor, d.currency, base, fxOf(d.currency)) });
    if (val && pos.shares.gt(0)) hf.push({ date: todayKey(), amount: val.marketValueBaseMinor });
    flows.push(...hf);
    all.push({
      stock, trades: st, pos, price, val, fxNow, stale: !price || Date.now() - price.updatedAt > STALE_MS || price.isManual,
      dividendsBaseMinor, dividendsYearMinor, costYieldPct: y.costYieldPct, priceYieldPct: y.priceYieldPct, sellNowNetMinor,
      xirr: xirr(hf),
    });
  }
  const holdings = all.filter((h) => h.pos.shares.gt(0));
  const closed = all.filter((h) => h.pos.shares.lte(0));
  const sum = (f: (h: Holding) => number, list = holdings) => list.reduce((a, h) => a + f(h), 0);
  const costBase = sum((h) => h.pos.costBaseMinor);
  const marketValueBase = sum((h) => h.val?.marketValueBaseMinor ?? Math.round(h.pos.costBaseMinor));
  const unrealizedBase = sum((h) => h.val?.unrealizedBaseMinor ?? 0);
  const realizedBase = sum((h) => h.pos.realizedBaseMinor, all);
  const dividendsBase = sum((h) => h.dividendsBaseMinor, all);
  const dividendsThisYearBase = dividends.filter((d) => d.kind === 'cash' && d.status === 'paid' && d.payDate.startsWith(thisYear))
    .reduce((a, d) => a + convertMinor(d.netMinor, d.currency, base, fxOf(d.currency)), 0);
  const todayBase = sum((h) => (h.val ? convertMinor(h.val.todayChangeMinor, h.stock.currency, base, h.fxNow) : 0));
  const lastUpdated = prices.length ? Math.max(...prices.map((p) => p.updatedAt)) : null;
  return {
    holdings: holdings.sort((a, b) => (b.val?.marketValueBaseMinor ?? 0) - (a.val?.marketValueBaseMinor ?? 0)),
    closed, costBase, marketValueBase, unrealizedBase, realizedBase, todayBase, dividendsBase, dividendsThisYearBase, investedBase,
    totalReturnPct: investedBase ? ((unrealizedBase + realizedBase) / investedBase) * 100 : 0,
    totalReturnWithDivPct: investedBase ? ((unrealizedBase + realizedBase + dividendsBase) / investedBase) * 100 : 0,
    xirr: xirr(flows),
    pricePnlBase: sum((h) => h.val?.pricePnlBaseMinor ?? 0),
    fxPnlBase: sum((h) => h.val?.fxPnlBaseMinor ?? 0),
    lastUpdated,
    missingPrice: holdings.filter((h) => !h.price).length,
  };
}

/** 依台股／一般規則估算賣出費稅 */
export function makeFeeEstimate(invest: InvestSettings) {
  const cfg: TwFeeConfig = {
    feeRateDec: invest.feeRateDec, discountDec: invest.discountDec, minFee: invest.minFee, oddLotMinFee: invest.oddLotMinFee,
    taxStockDec: invest.taxStockDec, taxEtfDec: invest.taxEtfDec, taxBondEtfDec: invest.taxBondEtfDec,
  };
  return (stock: Stock, priceDec: string, sharesDec: string) => {
    if (stock.currency !== 'TWD') return { fee: 0, tax: 0 }; // 美股多數券商免手續費，可於交易中手動填入
    return {
      fee: twFee(priceDec, sharesDec, cfg, stock.lotSize || 1000),
      tax: twSellTax(priceDec, sharesDec, twTaxRate(stock.assetType, cfg, stock.taxRateDec)),
    };
  };
}

export function twFeeConfig(invest: InvestSettings): TwFeeConfig {
  return {
    feeRateDec: invest.feeRateDec, discountDec: invest.discountDec, minFee: invest.minFee, oddLotMinFee: invest.oddLotMinFee,
    taxStockDec: invest.taxStockDec, taxEtfDec: invest.taxEtfDec, taxBondEtfDec: invest.taxBondEtfDec,
  };
}

export function usePortfolio(): PortfolioSummary | undefined {
  const base = useSettings((s) => s.baseCurrency);
  const invest = useSettings((s) => s.invest);
  return useLiveQuery(async () => {
    const [stocks, trades, prices, dividends, rates] = await Promise.all([
      db.stocks.toArray(), db.stock_trades.toArray(), db.price_cache.toArray(), db.dividends.toArray(), db.exchange_rates.toArray(),
    ]);
    return buildPortfolio({ stocks, trades, prices, dividends, rates, base, method: invest.costMethod, feeEstimate: makeFeeEstimate(invest) });
  }, [base, invest]);
}

/** 給淨資產、快照使用：目前投資市值（主幣別） */
export async function investMarketValueBase(): Promise<{ mv: number; cost: number; unrealized: number; realized: number; dividends: number; byStock: Record<string, { sharesDec: string; priceDec: string; mvMinor: number }> }> {
  const s = (await import('@/stores/settings')).useSettings.getState();
  const [stocks, trades, prices, dividends, rates] = await Promise.all([
    db.stocks.toArray(), db.stock_trades.toArray(), db.price_cache.toArray(), db.dividends.toArray(), db.exchange_rates.toArray(),
  ]);
  const p = buildPortfolio({ stocks, trades, prices, dividends, rates, base: s.baseCurrency, method: s.invest.costMethod, feeEstimate: makeFeeEstimate(s.invest) });
  const byStock: Record<string, { sharesDec: string; priceDec: string; mvMinor: number }> = {};
  for (const h of p.holdings) byStock[h.stock.id] = { sharesDec: h.pos.shares.toString(), priceDec: h.price?.priceDec ?? '0', mvMinor: h.val?.marketValueBaseMinor ?? 0 };
  return { mv: p.marketValueBase, cost: p.costBase, unrealized: p.unrealizedBase, realized: p.realizedBase, dividends: p.dividendsBase, byStock };
}

export const fmtShares = (d: Decimal) => (d.isInteger() ? d.toNumber().toLocaleString('zh-TW') : d.toDecimalPlaces(4).toString());
export { fromMinor };

/**
 * 盈虧日曆（P&L Calendar）純領域計算模組。
 * - 計算指定日期範圍內（如月曆 42 格或一週 7 天）每日的股票投資損益。
 * - 損益包含：
 *   1. 當日已實現損益（賣出／當沖沖銷平倉之淨利／淨損）。
 *   2. 當日未實現浮動損益（既有持股今日收盤 vs 昨日收盤價差、今日買入股票收盤 vs 買入成本價差）。
 * - 支援多幣別分開計算（如台股 TWD、美股 USD）。
 * - 休市日（週末、國定假日）無變動與無交易時自動留白。
 */
import Decimal from 'decimal.js';
import type { PriceCache, PriceHistory, Stock, StockTrade } from '@/db/types';
import { currencyInfo } from '@/domain/money';
import type { CostMethod } from './position';

export interface DayCurrencyPnl {
  currency: string;
  pnlMinor: number; // 當日損益（標的幣別最小單位整數，可正可負）
  baseValueMinor: number; // 當日基準市值或成本
  pnlPct: number; // 報酬率 %
}

export interface DayStockDetail {
  stockId: string;
  symbol: string;
  name: string;
  currency: string;
  market: string;
  heldShares: string; // 結算持股數
  tradeType?: 'buy' | 'sell' | 'both';
  tradeShares?: string;
  tradePrice?: string;
  closePriceDec: string;
  prevClosePriceDec?: string;
  priceChangePct?: number;
  pnlMinor: number; // 對當日總損益貢獻（已實現＋未實現）
  realizedMinor: number; // 當日已實現損益
  unrealizedChangeMinor: number; // 當日持股市值波動
  trades: StockTrade[];
}

export interface DayPnlResult {
  date: string;
  hasActivity: boolean; // 是否有持股變動或交易
  hasTrade: boolean; // 當日是否有買賣交易
  currencies: DayCurrencyPnl[]; // 分幣別損益列表（如 [TWD, USD]）
  stocks: DayStockDetail[]; // 當日各標的明細貢獻
}

export interface MonthCurrencySummary {
  currency: string;
  totalPnlMinor: number;
  winDays: number;
  lossDays: number;
  flatDays: number;
  totalDays: number;
  tradeDays: number;
  winRatePct: number;
}

export interface MonthPnlSummary {
  monthKey: string; // 'YYYY-MM'
  byCurrency: Map<string, MonthCurrencySummary>;
  currencies: MonthCurrencySummary[];
  totalTrades: number;
}

export interface ComputePnlCalendarParams {
  stocks: Stock[];
  trades: StockTrade[];
  priceCaches: PriceCache[];
  priceHistories: PriceHistory[];
  startDate: string; // 'YYYY-MM-DD'
  endDate: string; // 'YYYY-MM-DD'
  today: string; // 'YYYY-MM-DD'
  monthKey?: string; // 'YYYY-MM' (當月 key，用於計算 monthSummary)
  costMethod?: CostMethod;
}

const r0 = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

interface Lot {
  shares: Decimal;
  cost: Decimal; // 標的幣別最小單位
  date: string;
}

/**
 * 核心計算函數：純函式，給定輸入產生每日盈虧與月份摘要
 */
export function computePnlCalendar(params: ComputePnlCalendarParams): {
  days: Map<string, DayPnlResult>;
  monthSummary: MonthPnlSummary;
} {
  const {
    stocks,
    trades,
    priceCaches,
    priceHistories,
    startDate,
    endDate,
    today,
    monthKey,
    costMethod = 'avg',
  } = params;

  const targetMonth = monthKey || startDate.slice(0, 7);
  const cacheMap = new Map<string, PriceCache>(priceCaches.map((c) => [c.stockId, c]));

  // 整理各標的之歷史收盤日線：stockId -> Map<date, closeDec>
  const histMap = new Map<string, Map<string, string>>();
  const histDatesMap = new Map<string, string[]>();
  for (const h of priceHistories) {
    let m = histMap.get(h.stockId);
    if (!m) {
      m = new Map<string, string>();
      histMap.set(h.stockId, m);
    }
    m.set(h.date, h.closeDec);
  }
  for (const [sId, m] of histMap.entries()) {
    histDatesMap.set(sId, Array.from(m.keys()).sort());
  }

  // 取得不重複日期清單（由 startDate 到 endDate）
  const allDates: string[] = [];
  const currD = new Date(startDate);
  const endD = new Date(endDate);
  while (currD <= endD) {
    allDates.push(currD.toISOString().slice(0, 10));
    currD.setDate(currD.getDate() + 1);
  }

  // 依標的依序模擬每個日期的持股與損益
  // stockDayContributions: Map<date, DayStockDetail[]>
  const dateStockContributions = new Map<string, DayStockDetail[]>();
  for (const d of allDates) {
    dateStockContributions.set(d, []);
  }

  // 針對每一檔股票
  for (const stock of stocks) {
    const sTrades = trades
      .filter((t) => t.stockId === stock.id && !t.deletedAt)
      .sort((a, b) => (a.date === b.date ? a.ts - b.ts : a.date < b.date ? -1 : 1));

    if (sTrades.length === 0) continue;

    const exp = currencyInfo(stock.currency).exp;
    const unit = Decimal.pow(10, exp);
    const histDates = histDatesMap.get(stock.id) ?? [];
    const histPrices = histMap.get(stock.id) ?? new Map<string, string>();
    const cache = cacheMap.get(stock.id);

    let lots: Lot[] = [];
    let tradeIdx = 0;

    // 依序走訪所有日期（包含 startDate 之前可能有的交易累積）
    // 先找出最早交易日期
    const firstTradeDate = sTrades[0].date;
    const simStart = firstTradeDate < startDate ? firstTradeDate : startDate;

    const simDates: string[] = [];
    const simD = new Date(simStart);
    while (simD <= endD) {
      simDates.push(simD.toISOString().slice(0, 10));
      simD.setDate(simD.getDate() + 1);
    }

    for (const d of simDates) {
      const heldStartShares = lots.reduce((acc, l) => acc.plus(l.shares), new Decimal(0));
      const dayTrades: StockTrade[] = [];

      while (tradeIdx < sTrades.length && sTrades[tradeIdx].date === d) {
        dayTrades.push(sTrades[tradeIdx]);
        tradeIdx++;
      }

      // 處理當日交易
      let buyShares = new Decimal(0);
      let buyCostTotal = new Decimal(0);
      let buyFees = new Decimal(0);
      let sellShares = new Decimal(0);
      let realizedMinor = 0;

      for (const t of dayTrades) {
        const sh = new Decimal(t.sharesDec);
        if (t.type === 'buy') {
          const cost = new Decimal(t.priceDec).mul(sh).mul(unit).plus(t.feeMinor);
          lots.push({ shares: sh, cost, date: t.date });
          buyShares = buyShares.plus(sh);
          buyCostTotal = buyCostTotal.plus(new Decimal(t.priceDec).mul(sh).mul(unit));
          buyFees = buyFees.plus(t.feeMinor);
        } else if (t.type === 'stock_dividend') {
          lots.push({ shares: sh, cost: new Decimal(0), date: t.date });
        } else if (t.type === 'split') {
          lots = lots.map((l) => ({ ...l, shares: l.shares.mul(sh) }));
        } else if (t.type === 'sell') {
          const totalHeld = lots.reduce((acc, l) => acc.plus(l.shares), new Decimal(0));
          if (totalHeld.lte(0)) continue;

          const toSell = Decimal.min(sh, totalHeld);
          sellShares = sellShares.plus(toSell);
          const proceeds = new Decimal(t.priceDec).mul(toSell).mul(unit).minus(t.feeMinor).minus(t.taxMinor);
          let cost = new Decimal(0);

          if (costMethod === 'avg') {
            const ratio = toSell.div(totalHeld);
            const totalCost = lots.reduce((acc, l) => acc.plus(l.cost), new Decimal(0));
            cost = totalCost.mul(ratio);
            const keep = new Decimal(1).minus(ratio);
            lots = toSell.eq(totalHeld)
              ? []
              : [{ shares: totalHeld.minus(toSell), cost: totalCost.mul(keep), date: lots[0]?.date ?? t.date }];
          } else {
            let left = toSell;
            const next: Lot[] = [];
            for (const l of lots) {
              if (left.lte(0)) {
                next.push(l);
                continue;
              }
              const take = Decimal.min(left, l.shares);
              const ratio = take.div(l.shares);
              cost = cost.plus(l.cost.mul(ratio));
              left = left.minus(take);
              if (take.lt(l.shares)) {
                const keep = new Decimal(1).minus(ratio);
                next.push({ shares: l.shares.minus(take), cost: l.cost.mul(keep), date: l.date });
              }
            }
            lots = next;
          }

          realizedMinor += r0(proceeds.minus(cost));
        }
      }

      const heldEndShares = lots.reduce((acc, l) => acc.plus(l.shares), new Decimal(0));

      // 若該日在目標顯示範圍 [startDate, endDate] 內，計算當日損益與報價變動
      if (d >= startDate && d <= endDate) {
        let closePriceDec = '';
        let prevClosePriceDec: string | undefined;
        let deltaDec = new Decimal(0);
        let pctChange: number | undefined;

        if (d === today) {
          if (cache) {
            closePriceDec = cache.priceDec;
            prevClosePriceDec = cache.prevCloseDec || cache.priceDec;
            if (cache.changeDec) {
              deltaDec = new Decimal(cache.changeDec);
            } else if (prevClosePriceDec) {
              deltaDec = new Decimal(closePriceDec).minus(prevClosePriceDec);
            }
            pctChange = cache.changePctDec ? Number(cache.changePctDec) : undefined;
          }
        } else if (d < today) {
          const histClose = histPrices.get(d);
          if (histClose) {
            closePriceDec = histClose;
            // 尋找前一個交易日的收盤價
            const prevDates = histDates.filter((dt) => dt < d);
            if (prevDates.length > 0) {
              const lastDt = prevDates[prevDates.length - 1];
              prevClosePriceDec = histPrices.get(lastDt);
            }
            if (prevClosePriceDec) {
              deltaDec = new Decimal(closePriceDec).minus(prevClosePriceDec);
              const prev = new Decimal(prevClosePriceDec);
              if (!prev.isZero()) {
                pctChange = deltaDec.div(prev).mul(100).toNumber();
              }
            }
          }
        }

        // 計算未實現浮動收盤損益
        // 1. 既有且當日未賣出的持股：股數 × 當日漲跌
        const heldUnchanged = Decimal.max(0, heldStartShares.minus(sellShares));
        let unreal1 = new Decimal(0);
        if (heldUnchanged.gt(0) && !deltaDec.isZero()) {
          unreal1 = heldUnchanged.mul(deltaDec).mul(unit);
        }

        // 2. 當日新買入的股票：買進股數 × (收盤價 − 買入均價) − 買進手續費
        let unreal2 = new Decimal(0);
        if (buyShares.gt(0)) {
          if (closePriceDec) {
            const avgBuyPrice = buyCostTotal.div(buyShares).div(unit);
            unreal2 = buyShares.mul(new Decimal(closePriceDec).minus(avgBuyPrice)).mul(unit).minus(buyFees);
          } else {
            unreal2 = buyFees.negated();
          }
        }

        const unrealizedChangeMinor = r0(unreal1.plus(unreal2));
        const totalStockPnlMinor = realizedMinor + unrealizedChangeMinor;

        const hasTradesOnDay = dayTrades.length > 0;
        const hasPriceMovement = heldUnchanged.gt(0) && !deltaDec.isZero();

        // 只有當天有交易，或既有持股有價格漲跌，或有非零損益時，才標記為當日活動
        if (hasTradesOnDay || hasPriceMovement || totalStockPnlMinor !== 0) {
          let tradeType: 'buy' | 'sell' | 'both' | undefined;
          const hasBuy = dayTrades.some((t) => t.type === 'buy');
          const hasSell = dayTrades.some((t) => t.type === 'sell');
          if (hasBuy && hasSell) tradeType = 'both';
          else if (hasBuy) tradeType = 'buy';
          else if (hasSell) tradeType = 'sell';

          let tradeShares: string | undefined;
          let tradePrice: string | undefined;
          if (dayTrades.length === 1) {
            tradeShares = dayTrades[0].sharesDec;
            tradePrice = dayTrades[0].priceDec;
          } else if (dayTrades.length > 1) {
            tradeShares = buyShares.plus(sellShares).toString();
          }

          const contribution: DayStockDetail = {
            stockId: stock.id,
            symbol: stock.symbol,
            name: stock.name,
            currency: stock.currency,
            market: stock.market,
            heldShares: heldEndShares.toString(),
            tradeType,
            tradeShares,
            tradePrice,
            closePriceDec: closePriceDec || (dayTrades[0]?.priceDec ?? '0'),
            prevClosePriceDec,
            priceChangePct: pctChange,
            pnlMinor: totalStockPnlMinor,
            realizedMinor,
            unrealizedChangeMinor,
            trades: dayTrades,
          };

          dateStockContributions.get(d)?.push(contribution);
        }
      }
    }
  }

  // 彙整每日結果與多幣別損益
  const dayResults = new Map<string, DayPnlResult>();
  const monthByCurrency = new Map<string, MonthCurrencySummary>();
  let totalTradesCount = 0;

  for (const d of allDates) {
    const stockContribs = dateStockContributions.get(d) ?? [];
    const hasTrade = stockContribs.some((s) => s.trades.length > 0);
    const hasActivity = stockContribs.length > 0;

    // 按幣別分組
    const curMap = new Map<string, { pnlMinor: number; baseValueMinor: number }>();
    for (const sc of stockContribs) {
      const cur = sc.currency;
      const prev = curMap.get(cur) ?? { pnlMinor: 0, baseValueMinor: 0 };
      const exp = currencyInfo(cur).exp;
      const unit = Decimal.pow(10, exp);

      // 計算基準市值（昨日收盤市值或買進成本）
      const basePrice = sc.prevClosePriceDec || sc.closePriceDec;
      const baseVal = new Decimal(sc.heldShares).mul(basePrice || 1).mul(unit).toNumber();

      curMap.set(cur, {
        pnlMinor: prev.pnlMinor + sc.pnlMinor,
        baseValueMinor: prev.baseValueMinor + Math.max(1, baseVal),
      });

      totalTradesCount += sc.trades.length;
    }

    const currencies: DayCurrencyPnl[] = [];
    // 優先排序：TWD 在前、USD 在後、其他在後
    const curKeys = Array.from(curMap.keys()).sort((a, b) => {
      if (a === 'TWD') return -1;
      if (b === 'TWD') return 1;
      if (a === 'USD') return -1;
      if (b === 'USD') return 1;
      return a.localeCompare(b);
    });

    for (const cur of curKeys) {
      const data = curMap.get(cur)!;
      const pnlPct = data.baseValueMinor > 0 ? (data.pnlMinor / data.baseValueMinor) * 100 : 0;
      currencies.push({
        currency: cur,
        pnlMinor: data.pnlMinor,
        baseValueMinor: data.baseValueMinor,
        pnlPct,
      });

      // 累計月份統計（僅累計目標月份）
      if (d.startsWith(targetMonth) && (data.pnlMinor !== 0 || hasTrade)) {
        let mSummary = monthByCurrency.get(cur);
        if (!mSummary) {
          mSummary = {
            currency: cur,
            totalPnlMinor: 0,
            winDays: 0,
            lossDays: 0,
            flatDays: 0,
            totalDays: 0,
            tradeDays: 0,
            winRatePct: 0,
          };
          monthByCurrency.set(cur, mSummary);
        }

        mSummary.totalPnlMinor += data.pnlMinor;
        mSummary.totalDays += 1;
        if (data.pnlMinor > 0) mSummary.winDays += 1;
        else if (data.pnlMinor < 0) mSummary.lossDays += 1;
        else mSummary.flatDays += 1;
        if (hasTrade) mSummary.tradeDays += 1;
      }
    }

    dayResults.set(d, {
      date: d,
      hasActivity,
      hasTrade,
      currencies,
      stocks: stockContribs.sort((a, b) => Math.abs(b.pnlMinor) - Math.abs(a.pnlMinor)),
    });
  }

  // 計算月份勝率
  for (const sum of monthByCurrency.values()) {
    const decDays = sum.winDays + sum.lossDays;
    sum.winRatePct = decDays > 0 ? (sum.winDays / decDays) * 100 : sum.winDays > 0 ? 100 : 0;
  }

  const monthCurrencies = Array.from(monthByCurrency.values()).sort((a, b) => {
    if (a.currency === 'TWD') return -1;
    if (b.currency === 'TWD') return 1;
    if (a.currency === 'USD') return -1;
    if (b.currency === 'USD') return 1;
    return a.currency.localeCompare(b.currency);
  });

  return {
    days: dayResults,
    monthSummary: {
      monthKey: targetMonth,
      byCurrency: monthByCurrency,
      currencies: monthCurrencies,
      totalTrades: totalTradesCount,
    },
  };
}

/**
 * 格式化單一幣別損益（緊湊微縮顯示）
 * @param pnl 幣別損益物件
 * @param showPrefix 是否包含幣別前綴（如 NT$ 或 US$）
 */
export function formatPnlCompact(pnl: DayCurrencyPnl, showPrefix = false): string {
  const isPos = pnl.pnlMinor > 0;
  const isNeg = pnl.pnlMinor < 0;
  const sign = isPos ? '+' : isNeg ? '-' : '';
  const absVal = Math.abs(pnl.pnlMinor) / 100;

  let valStr: string;
  if (pnl.currency === 'TWD') {
    if (absVal >= 100000) {
      valStr = `${(absVal / 10000).toFixed(1)}萬`;
    } else if (absVal >= 10000) {
      valStr = `${(absVal / 1000).toFixed(1)}k`;
    } else {
      valStr = Math.round(absVal).toLocaleString('en-US');
    }
  } else {
    // USD
    if (absVal >= 10000) {
      valStr = `${(absVal / 1000).toFixed(1)}k`;
    } else if (absVal >= 100) {
      valStr = Math.round(absVal).toLocaleString('en-US');
    } else {
      valStr = absVal.toFixed(1);
    }
  }

  const prefix = showPrefix ? (pnl.currency === 'TWD' ? 'NT$' : 'US$') : '$';
  return `${prefix}${sign}${valStr}`;
}

/**
 * 格式化報酬率 %
 */
export function formatPnlPct(pct: number): string {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

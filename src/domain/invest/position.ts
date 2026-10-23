/**
 * 持倉計算（單一標的）。金額以「標的幣別最小單位」整數計，股數／價格以 Decimal。
 *
 * 成本法：
 * - avg（加權平均）：買進成本含手續費；賣出時按比例沖銷：沖銷成本 = 總成本 × 賣出股數 ÷ 持有股數
 * - fifo（先進先出）：逐批沖銷最早買進的批次
 * 配股（stock_dividend）：增加股數、成本不變 → 平均成本下降。
 * 分割（split）：sharesDec 代表倍數（例 '4' = 1 拆 4），股數 × 倍數、成本不變。
 *
 * 匯率：每筆買進記錄當時 fxRateDec（標的幣別→主幣別），用於拆分「股價損益」與「匯差損益」。
 */
import Decimal from 'decimal.js';
import type { StockTrade } from '@/db/types';

export type CostMethod = 'avg' | 'fifo';

interface Lot {
  shares: Decimal;
  cost: Decimal; // 標的幣別最小單位
  costBase: Decimal; // 主幣別最小單位
  date: string;
}

export interface Realized {
  tradeId: string;
  date: string;
  shares: Decimal;
  proceedsMinor: number; // 賣出淨收入（扣費稅）
  costMinor: number; // 沖銷成本
  pnlMinor: number;
  pnlBaseMinor: number; // 以主幣別計（賣出匯率 × 收入 − 買入時主幣別成本）
}

export interface Position {
  shares: Decimal;
  costMinor: number; // 剩餘持股總成本（含買進手續費）
  costBaseMinor: number; // 剩餘持股主幣別成本
  avgCost: Decimal; // 每股平均成本（標的幣別「主單位」）
  realized: Realized[];
  realizedMinor: number;
  realizedBaseMinor: number;
  buyCount: number;
  firstDate?: string;
}

type T = Pick<StockTrade, 'id' | 'type' | 'date' | 'ts' | 'sharesDec' | 'priceDec' | 'feeMinor' | 'taxMinor' | 'fxRateDec' | 'deletedAt'>;

const r0 = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

/**
 * @param exp 標的幣別小數位（TWD/USD = 2）
 */
export function computePosition(trades: T[], method: CostMethod, exp = 2): Position {
  const unit = Decimal.pow(10, exp);
  const sorted = trades.filter((t) => !t.deletedAt).sort((a, b) => (a.date === b.date ? a.ts - b.ts : a.date < b.date ? -1 : 1));
  let lots: Lot[] = [];
  const realized: Realized[] = [];
  let buyCount = 0;
  let firstDate: string | undefined;

  const totals = () => lots.reduce((acc, l) => ({ shares: acc.shares.plus(l.shares), cost: acc.cost.plus(l.cost), costBase: acc.costBase.plus(l.costBase) }),
    { shares: new Decimal(0), cost: new Decimal(0), costBase: new Decimal(0) });

  for (const t of sorted) {
    const shares = new Decimal(t.sharesDec);
    const fx = new Decimal(t.fxRateDec || 1);
    if (t.type === 'buy') {
      const cost = new Decimal(t.priceDec).mul(shares).mul(unit).plus(t.feeMinor);
      lots.push({ shares, cost, costBase: cost.mul(fx), date: t.date });
      buyCount++;
      firstDate ??= t.date;
    } else if (t.type === 'stock_dividend') {
      lots.push({ shares, cost: new Decimal(0), costBase: new Decimal(0), date: t.date });
    } else if (t.type === 'split') {
      lots = lots.map((l) => ({ ...l, shares: l.shares.mul(shares) }));
    } else if (t.type === 'sell') {
      const held = totals();
      if (held.shares.lte(0)) continue;
      const sellShares = Decimal.min(shares, held.shares);
      const proceeds = new Decimal(t.priceDec).mul(sellShares).mul(unit).minus(t.feeMinor).minus(t.taxMinor);
      let cost = new Decimal(0);
      let costBase = new Decimal(0);
      if (method === 'avg') {
        const ratio = sellShares.div(held.shares);
        cost = held.cost.mul(ratio);
        costBase = held.costBase.mul(ratio);
        const keep = new Decimal(1).minus(ratio);
        lots = sellShares.eq(held.shares) ? [] : [{ shares: held.shares.minus(sellShares), cost: held.cost.mul(keep), costBase: held.costBase.mul(keep), date: lots[0]?.date ?? t.date }];
      } else {
        let left = sellShares;
        const next: Lot[] = [];
        for (const l of lots) {
          if (left.lte(0)) { next.push(l); continue; }
          const take = Decimal.min(left, l.shares);
          const ratio = take.div(l.shares);
          cost = cost.plus(l.cost.mul(ratio));
          costBase = costBase.plus(l.costBase.mul(ratio));
          left = left.minus(take);
          if (take.lt(l.shares)) {
            const keep = new Decimal(1).minus(ratio);
            next.push({ shares: l.shares.minus(take), cost: l.cost.mul(keep), costBase: l.costBase.mul(keep), date: l.date });
          }
        }
        lots = next;
      }
      realized.push({
        tradeId: t.id, date: t.date, shares: sellShares,
        proceedsMinor: r0(proceeds), costMinor: r0(cost), pnlMinor: r0(proceeds.minus(cost)),
        pnlBaseMinor: r0(proceeds.mul(fx).minus(costBase)),
      });
    }
  }
  const h = totals();
  return {
    shares: h.shares,
    costMinor: r0(h.cost),
    costBaseMinor: r0(h.costBase),
    avgCost: h.shares.gt(0) ? h.cost.div(unit).div(h.shares) : new Decimal(0),
    realized,
    realizedMinor: realized.reduce((a, r) => a + r.pnlMinor, 0),
    realizedBaseMinor: realized.reduce((a, r) => a + r.pnlBaseMinor, 0),
    buyCount,
    firstDate,
  };
}

export interface Valuation {
  marketValueMinor: number;
  unrealizedMinor: number;
  unrealizedPct: number;
  todayChangeMinor: number;
  todayChangePct: number;
  /** 主幣別：市值、未實現、股價損益、匯差損益 */
  marketValueBaseMinor: number;
  unrealizedBaseMinor: number;
  pricePnlBaseMinor: number;
  fxPnlBaseMinor: number;
}

/**
 * 估值。價格損益與匯差拆分：
 *   總損益(主幣) = 市值 × 現匯 − 主幣成本
 *   股價損益     = (市值 − 原幣成本) × 現匯
 *   匯差損益     = 原幣成本 × 現匯 − 主幣成本
 */
export function valuate(pos: Position, priceDec: Decimal.Value, prevCloseDec: Decimal.Value | null, fxNowDec: Decimal.Value, exp = 2): Valuation {
  const unit = Decimal.pow(10, exp);
  const mv = pos.shares.mul(priceDec).mul(unit);
  const fx = new Decimal(fxNowDec || 1);
  const cost = new Decimal(pos.costMinor);
  const unreal = mv.minus(cost);
  const prev = prevCloseDec ? new Decimal(prevCloseDec) : null;
  const today = prev && !prev.isZero() ? pos.shares.mul(new Decimal(priceDec).minus(prev)).mul(unit) : new Decimal(0);
  return {
    marketValueMinor: r0(mv),
    unrealizedMinor: r0(unreal),
    unrealizedPct: cost.isZero() ? 0 : unreal.div(cost).mul(100).toNumber(),
    todayChangeMinor: r0(today),
    todayChangePct: prev && !prev.isZero() ? new Decimal(priceDec).minus(prev).div(prev).mul(100).toNumber() : 0,
    marketValueBaseMinor: r0(mv.mul(fx)),
    unrealizedBaseMinor: r0(mv.mul(fx).minus(pos.costBaseMinor)),
    pricePnlBaseMinor: r0(unreal.mul(fx)),
    fxPnlBaseMinor: r0(cost.mul(fx).minus(pos.costBaseMinor)),
  };
}

/** 殖利率：成本殖利率 = 近 12 個月每股股利 ÷ 平均成本；現價殖利率 = ÷ 現價 */
export function yields(trailingDpsDec: Decimal.Value, avgCost: Decimal, priceDec: Decimal.Value) {
  const dps = new Decimal(trailingDpsDec);
  return {
    costYieldPct: avgCost.gt(0) ? dps.div(avgCost).mul(100).toNumber() : 0,
    priceYieldPct: new Decimal(priceDec).gt(0) ? dps.div(priceDec).mul(100).toNumber() : 0,
  };
}

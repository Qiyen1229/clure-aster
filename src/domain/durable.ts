/**
 * 耐用物品的「每日持有成本」與「每次使用成本」（純函式，金額為最小單位整數）。
 * 買一支 36,900 的手機不該只算在買的那個月：它陪你的每一天都在攤提。
 *   每日成本 ＝（購入價 − 賣掉的殘值）÷ 持有天數
 * 還在用就以今天為止；已賣掉或淘汰就以處置日為止。
 */
export interface DurableCalcInput {
  costMinor: number;
  purchaseDate: string; // YYYY-MM-DD
  lifeYears?: number;
  uses?: number;
  status: 'active' | 'sold' | 'retired';
  endDate?: string;
  saleMinor?: number;
}

const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** 持有天數（購入當天算第 1 天，至少 1） */
export function daysHeld(purchaseDate: string, until: string): number {
  return Math.max(1, Math.round((t(until) - t(purchaseDate)) / DAY) + 1);
}

export interface DurableStats {
  days: number;
  /** 扣掉殘值後的淨成本（沒賣掉＝購入價；賣得比買得貴＝0） */
  netCostMinor: number;
  /** 目前（或處置時）每日成本 */
  perDayMinor: number;
  /** 不扣殘值的每日成本（賣掉時用來對照） */
  grossPerDayMinor: number;
  /** 預計壽命天數（有設定才有） */
  lifeDays?: number;
  /** 已用掉預計壽命的比例 0～1（可超過 1 代表用超過預計） */
  usedRatio?: number;
  /** 依預計壽命，每天應該攤的成本（目標） */
  targetPerDayMinor?: number;
  /** 距離預計壽命還有幾天（負數＝已超過） */
  remainingDays?: number;
  /** 每次使用成本（有填使用次數才有） */
  perUseMinor?: number;
  /** 再用 N 天後的每日成本，用來看「用越久越划算」 */
  perDayAfter?: (extraDays: number) => number;
}

export function durableStats(d: DurableCalcInput, today: string): DurableStats {
  const until = d.status === 'active' ? today : d.endDate ?? today;
  const days = daysHeld(d.purchaseDate, until);
  const net = d.status === 'sold' ? Math.max(0, d.costMinor - (d.saleMinor ?? 0)) : d.costMinor;
  const lifeDays = d.lifeYears && d.lifeYears > 0 ? Math.round(d.lifeYears * 365) : undefined;
  return {
    days,
    netCostMinor: net,
    perDayMinor: Math.round(net / days),
    grossPerDayMinor: Math.round(d.costMinor / days),
    lifeDays,
    usedRatio: lifeDays ? days / lifeDays : undefined,
    targetPerDayMinor: lifeDays ? Math.round(d.costMinor / lifeDays) : undefined,
    remainingDays: lifeDays ? lifeDays - days : undefined,
    perUseMinor: d.uses && d.uses > 0 ? Math.round(net / d.uses) : undefined,
    perDayAfter: (extra) => Math.round(net / (days + Math.max(0, extra))),
  };
}

/** 所有還在用的物品，每天合計在「燒」多少錢 */
export function totalDailyBurn(list: (DurableCalcInput & { currency: string })[], today: string, currency: string): number {
  return list.filter((d) => d.status === 'active' && d.currency === currency).reduce((s, d) => s + durableStats(d, today).perDayMinor, 0);
}

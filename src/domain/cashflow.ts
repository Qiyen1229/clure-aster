/**
 * 現金流預測（純函式）：從「現在可動用的錢」（現金、銀行、電子支付、儲值）出發，
 * 把未來已知的收支（週期帳目、信用卡繳款、分期、貸款）逐日加減，找出最低點與哪個帳戶會不夠付。
 * 日常花費（吃飯、交通這類不固定的支出）以近期平均估算，只算進總額曲線、不分攤到個別帳戶。
 */
import { addDays, type DateKey } from './period';

export type CashEventKind = 'recurring' | 'card' | 'installment' | 'loan';

export interface CashEvent {
  date: DateKey;
  accountId: string;
  /** 帳戶幣別最小單位；正數＝入帳，負數＝扣款 */
  amountMinor: number;
  label: string;
  kind: CashEventKind;
  /** 沒有設定扣款帳戶，先假設從這個帳戶扣 */
  assumed?: boolean;
}

export interface CashAccount {
  id: string;
  name: string;
  currency: string;
  balanceMinor: number;
  /** 帳戶幣別 1 個最小單位換算成主幣別最小單位的倍數 */
  toBase: number;
}

export interface Shortfall {
  accountId: string;
  date: DateKey;
  /** 扣款後的餘額（負數） */
  balanceMinor: number;
  label: string;
}

export interface Forecast {
  series: { date: DateKey; total: number }[];
  start: number;
  end: number;
  lowest: { date: DateKey; total: number };
  shortfalls: Shortfall[];
  /** 期間內已知的收入、支出合計（主幣別） */
  knownIn: number;
  knownOut: number;
  estimatedSpend: number;
}

export function forecast(input: {
  today: DateKey;
  days: number;
  accounts: CashAccount[];
  events: CashEvent[];
  /** 平均每天的日常花費（主幣別最小單位）；0＝不估算 */
  dailySpendBase: number;
}): Forecast {
  const { today, days, accounts } = input;
  const bal = new Map(accounts.map((a) => [a.id, a.balanceMinor]));
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const byDate = new Map<DateKey, CashEvent[]>();
  for (const e of input.events) {
    if (!acc.has(e.accountId)) continue;
    const d = e.date < today ? today : e.date;
    const list = byDate.get(d) ?? [];
    list.push(e);
    byDate.set(d, list);
  }
  const totalNow = () => accounts.reduce((s, a) => s + Math.round((bal.get(a.id) ?? 0) * a.toBase), 0);
  const start = totalNow();
  const series: Forecast['series'] = [];
  const shortfalls: Shortfall[] = [];
  const short = new Set<string>();
  let knownIn = 0, knownOut = 0, spent = 0;
  let lowest = { date: today, total: start };
  for (let i = 0; i <= days; i++) {
    const d = addDays(today, i);
    // 同一天先入帳再扣款（薪水和卡費同一天時不算不夠）
    const list = (byDate.get(d) ?? []).slice().sort((a, b) => b.amountMinor - a.amountMinor);
    for (const e of list) {
      const a = acc.get(e.accountId)!;
      const next = (bal.get(a.id) ?? 0) + e.amountMinor;
      bal.set(a.id, next);
      const v = Math.round(e.amountMinor * a.toBase);
      if (v > 0) knownIn += v; else knownOut -= v;
      if (next < 0 && e.amountMinor < 0 && !short.has(a.id)) {
        short.add(a.id);
        shortfalls.push({ accountId: a.id, date: d, balanceMinor: next, label: e.label });
      }
    }
    if (i > 0) spent += input.dailySpendBase;
    const total = totalNow() - spent;
    series.push({ date: d, total });
    if (total < lowest.total) lowest = { date: d, total };
  }
  return { series, start, end: series[series.length - 1].total, lowest, shortfalls, knownIn, knownOut, estimatedSpend: spent };
}

/** 估算每天的日常花費：期間內「不是週期、分期、投資」的支出總和 ÷ 天數 */
export function dailyVariableSpend(txs: { type: string; baseAmountMinor: number; recurringRuleId?: string; installmentId?: string; stockTradeId?: string; transferId?: string; excludeFromStats?: boolean; deletedAt?: number | null }[], days: number): number {
  let sum = 0;
  for (const t of txs) {
    if (t.deletedAt || t.type !== 'expense' || t.recurringRuleId || t.installmentId || t.stockTradeId || t.transferId || t.excludeFromStats) continue;
    sum += t.baseAmountMinor;
  }
  return days > 0 ? Math.round(sum / days) : 0;
}

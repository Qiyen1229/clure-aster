/**
 * 股利行事曆：產生某一年 1～12 月的「已領」與「預估」現金股利分佈。
 *  - 已領：該年已發放的現金股利（淨額）
 *  - 已公告：status=announced 的股利，以公告資料計入預估
 *  - 依歷史推估：對目前持有的標的，取去年（同月份）發放紀錄；新持股沒有去年紀錄時改用近 12 個月紀錄，
 *    以「每股股利 × 目前持股數」估算尚未到來月份的股利（已過去的月份不再推估）
 * 金額皆換算主幣別（呼叫端提供換算函式）。
 */
import Decimal from 'decimal.js';
import type { Dividend } from '@/db/types';

export interface CalendarItem { stockId: string; amountMinor: number; kind: 'paid' | 'announced' | 'estimated'; perShareDec: string }
export interface MonthBucket { month: number; paidMinor: number; projectedMinor: number; items: CalendarItem[] }

export function dividendCalendar(params: {
  year: number;
  today: string;
  dividends: Pick<Dividend, 'stockId' | 'kind' | 'status' | 'payDate' | 'perShareDec' | 'netMinor' | 'grossMinor' | 'currency'>[];
  /** 目前持股數（只有持有中的標的才會推估） */
  holdings: Map<string, { sharesDec: string; currency: string; exp: number }>;
  toBase: (minor: number, currency: string) => number;
}): { months: MonthBucket[]; paidMinor: number; projectedMinor: number } {
  const { year, today, dividends, holdings, toBase } = params;
  const months: MonthBucket[] = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, paidMinor: 0, projectedMinor: 0, items: [] }));
  const cash = dividends.filter((d) => d.kind === 'cash');
  const ym = (d: string) => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) });
  const thisMonthKey = today.slice(0, 7);
  const taken = new Set<string>(); // stockId:month 已有實際或公告資料

  for (const d of cash) {
    const { y, m } = ym(d.payDate);
    if (y !== year) continue;
    const b = months[m - 1];
    if (d.status === 'paid') {
      const v = toBase(d.netMinor, d.currency);
      b.paidMinor += v;
      b.items.push({ stockId: d.stockId, amountMinor: v, kind: 'paid', perShareDec: d.perShareDec });
    } else {
      const h = holdings.get(d.stockId);
      const gross = d.grossMinor || (h ? new Decimal(d.perShareDec).mul(h.sharesDec).mul(Decimal.pow(10, h.exp)).floor().toNumber() : 0);
      const v = toBase(gross, d.currency);
      b.projectedMinor += v;
      b.items.push({ stockId: d.stockId, amountMinor: v, kind: 'announced', perShareDec: d.perShareDec });
    }
    taken.add(`${d.stockId}:${m}`);
  }

  // 依歷史推估尚未到來的月份
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  for (const [stockId, h] of holdings) {
    if (new Decimal(h.sharesDec).lte(0)) continue;
    const mine = cash.filter((d) => d.stockId === stockId && d.status === 'paid');
    let basis = mine.filter((d) => ym(d.payDate).y === year - 1);
    if (!basis.length) basis = mine.filter((d) => d.payDate > yearAgo && d.payDate <= today);
    for (const d of basis) {
      const m = ym(d.payDate).m;
      const key = `${year}-${String(m).padStart(2, '0')}`;
      if (key < thisMonthKey || taken.has(`${stockId}:${m}`)) continue;
      const gross = new Decimal(d.perShareDec).mul(h.sharesDec).mul(Decimal.pow(10, h.exp)).floor().toNumber();
      const v = toBase(gross, h.currency);
      months[m - 1].projectedMinor += v;
      months[m - 1].items.push({ stockId, amountMinor: v, kind: 'estimated', perShareDec: d.perShareDec });
      taken.add(`${stockId}:${m}`);
    }
  }
  return {
    months,
    paidMinor: months.reduce((a, b) => a + b.paidMinor, 0),
    projectedMinor: months.reduce((a, b) => a + b.projectedMinor, 0),
  };
}

/**
 * 稅務彙總的資料來源：依年度（發放日／賣出日）彙整股利與已實現損益，換算主幣別「元」。
 */
import { db } from '@/db/schema';
import type { Market } from '@/db/types';
import { computePosition } from '@/domain/invest/position';
import { convertMinor, currencyInfo, fromMinor } from '@/domain/money';
import type { InvestIncome } from '@/domain/tax';
import { resolveRate } from './fx';

const DOMESTIC: Market[] = ['TWSE', 'TPEX', 'EMERGING'];

export interface TaxDetailRow { stockId: string; symbol: string; name: string; market: Market; dividend: number; withholding: number; nhi: number; realized: number }

export async function investIncomeForYear(year: string, base: string, method: 'avg' | 'fifo'): Promise<{ income: InvestIncome; rows: TaxDetailRow[] }> {
  const [stocks, trades, dividends, rates] = await Promise.all([db.stocks.toArray(), db.stock_trades.toArray(), db.dividends.toArray(), db.exchange_rates.toArray()]);
  const rateMap = new Map(rates.map((r) => [`${r.base}>${r.quote}`, r]));
  const fx = (cur: string) => (cur === base ? '1' : resolveRate(rateMap, cur, base)?.toString() ?? '1');
  const toBase = (minor: number, cur: string) => fromMinor(convertMinor(minor, cur, base, fx(cur)), base).toNumber();
  const income: InvestIncome = { domesticDividend: 0, nhi: 0, foreignDividend: 0, foreignWithholding: 0, foreignRealized: 0, domesticRealized: 0 };
  const rows: TaxDetailRow[] = [];
  for (const s of stocks) {
    const domestic = DOMESTIC.includes(s.market);
    const divs = dividends.filter((d) => d.stockId === s.id && d.kind === 'cash' && d.status === 'paid' && d.payDate.startsWith(year) && !d.deletedAt);
    const dividend = divs.reduce((a, d) => a + toBase(d.grossMinor, d.currency), 0);
    const withholding = divs.reduce((a, d) => a + toBase(d.withholdingTaxMinor, d.currency), 0);
    const nhi = divs.reduce((a, d) => a + toBase(d.nhiSupplementMinor, d.currency), 0);
    const st = trades.filter((t) => t.stockId === s.id && !t.deletedAt);
    const pos = st.length ? computePosition(st, method, currencyInfo(s.currency).exp) : null;
    // 已實現損益以主幣別（含匯差）計
    const realized = (pos?.realized ?? []).filter((r) => r.date.startsWith(year)).reduce((a, r) => a + fromMinor(r.pnlBaseMinor, base).toNumber(), 0);
    if (!dividend && !realized) continue;
    rows.push({ stockId: s.id, symbol: s.symbol, name: s.name, market: s.market, dividend, withholding, nhi, realized });
    if (domestic) {
      income.domesticDividend += dividend;
      income.nhi += nhi;
      income.domesticRealized += realized;
    } else {
      income.foreignDividend += dividend;
      income.foreignWithholding += withholding;
      income.foreignRealized += realized;
    }
  }
  const r = (v: number) => Math.round(v);
  return {
    income: Object.fromEntries(Object.entries(income).map(([k, v]) => [k, r(v)])) as unknown as InvestIncome,
    rows: rows.sort((a, b) => b.dividend + Math.abs(b.realized) - a.dividend - Math.abs(a.realized)),
  };
}

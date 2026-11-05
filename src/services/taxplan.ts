/**
 * 稅務規劃的資料層：把持股、已領／已公告股利、去年的配息紀錄整理成「即將除息」事件，交給 domain/taxplan 分析，
 * 並算出海外所得控管（含未實現虧損）。全部在本機算、不呼叫 AI；估算僅供參考。
 */
import { db } from '@/db/schema';
import type { Market, Stock } from '@/db/types';
import { addDays, todayKey } from '@/domain/period';
import { DEFAULT_TAX_PARAMS, type TaxParams } from '@/domain/tax';
import { computePosition } from '@/domain/invest/position';
import { twFee, twSellTax, twTaxRate } from '@/domain/invest/fees-tw';
import { currencyInfo, fromMinor } from '@/domain/money';
import { analyzeDividend, overseasWatch, type DivAnalysis, type DivEvent, type OverseasWatch } from '@/domain/taxplan';
import { useSettings } from '@/stores/settings';
import { buildPortfolio, makeFeeEstimate, twFeeConfig } from './portfolio';
import { investIncomeForYear } from './tax';
import { notify } from './notifications';

const DOMESTIC: Market[] = ['TWSE', 'TPEX', 'EMERGING'];
const HORIZON_DAYS = 120;

export interface TaxPlan {
  year: number;
  params: TaxParams;
  netIncomeSet: boolean;
  events: DivAnalysis[];
  overseas: OverseasWatch | null;
}

const plusYear = (d: string | null | undefined) => (d ? `${Number(d.slice(0, 4)) + 1}${d.slice(4)}` : null);

export async function loadTaxPlan(today = todayKey()): Promise<TaxPlan> {
  const st = useSettings.getState();
  const year = Number(today.slice(0, 4));
  const params: TaxParams = { ...DEFAULT_TAX_PARAMS, netIncome: st.tax.netIncome };
  const cfg = twFeeConfig(st.invest);
  const [stocks, trades, dividends, prices, rates] = await Promise.all([db.stocks.toArray(), db.stock_trades.toArray(), db.dividends.toArray(), db.price_cache.toArray(), db.exchange_rates.toArray()]);
  const priceOf = new Map(prices.map((p) => [p.stockId, Number(p.priceDec)]));
  const held = new Map<string, { stock: Stock; shares: number }>();
  for (const s of stocks) {
    if (!DOMESTIC.includes(s.market)) continue;
    const ts = trades.filter((t) => t.stockId === s.id && !t.deletedAt);
    if (!ts.length) continue;
    const shares = computePosition(ts, st.invest.costMethod, currencyInfo(s.currency).exp).shares.toNumber();
    if (shares > 0) held.set(s.id, { stock: s, shares });
  }
  const cash = dividends.filter((d) => d.kind === 'cash' && !d.deletedAt && d.currency === 'TWD' && (DOMESTIC.includes(stocks.find((s) => s.id === d.stockId)?.market as Market)));
  const yuan = (minor: number) => fromMinor(minor, 'TWD').toNumber();

  // 事件：已公告（未來的）＋ 依去年推估（沒有公告的持股）
  const events: DivEvent[] = [];
  const end = addDays(today, HORIZON_DAYS);
  for (const d of cash.filter((x) => x.status === 'announced')) {
    const h = held.get(d.stockId);
    const when = d.exDate || d.payDate;
    if (!h || when < today || when > end) continue;
    const per = Number(d.perShareDec);
    events.push({ stockId: h.stock.id, symbol: h.stock.symbol, name: h.stock.name, assetType: h.stock.assetType, exDate: d.exDate || null, payDate: d.payDate || null, source: 'announced', shares: h.shares, perShare: per, price: priceOf.get(h.stock.id) ?? 0, gross: d.grossMinor ? yuan(d.grossMinor) : Math.floor(per * h.shares) });
  }
  const yearAgo = addDays(today, -365);
  for (const [id, h] of held) {
    if (events.some((e) => e.stockId === id)) continue;
    for (const d of cash.filter((x) => x.stockId === id && x.status === 'paid' && x.payDate > yearAgo)) {
      const ex = plusYear(d.exDate || null), pay = plusYear(d.payDate);
      const when = ex ?? pay;
      if (!when || when < today || when > end) continue;
      const per = Number(d.perShareDec);
      events.push({ stockId: id, symbol: h.stock.symbol, name: h.stock.name, assetType: h.stock.assetType, exDate: ex, payDate: pay, source: 'estimated', shares: h.shares, perShare: per, price: priceOf.get(id) ?? 0, gross: Math.floor(per * h.shares) });
    }
  }
  events.sort((a, b) => ((a.exDate ?? a.payDate ?? '') < (b.exDate ?? b.payDate ?? '') ? -1 : 1));

  // 同一年度其他國內股利（已領＋這批事件裡的其他筆）＝邊際稅額的基準
  const payYear = (e: DivEvent) => Number((e.payDate ?? e.exDate ?? today).slice(0, 4));
  const paidInYear = (y: number) => cash.filter((d) => d.status === 'paid' && d.payDate.startsWith(String(y))).reduce((a, d) => a + yuan(d.grossMinor), 0);
  const analyses = events.map((e) => {
    const others = paidInYear(payYear(e)) + events.filter((x) => x !== e && payYear(x) === payYear(e)).reduce((a, x) => a + x.gross, 0);
    const fee = (price: number) => twFee(price, e.shares, cfg, held.get(e.stockId)?.stock.lotSize || 1000) / 100;
    const tax = twSellTax(e.price, e.shares, twTaxRate(e.assetType, cfg, held.get(e.stockId)?.stock.taxRateDec)) / 100;
    const costs = e.price > 0 ? { sellFee: fee(e.price), sellTax: tax, buyFee: fee(Math.max(0, e.price - e.perShare)) } : null;
    return analyzeDividend(e, others, params, costs);
  });

  // 海外所得控管：今年的海外股利＋已實現，以及海外持股的未實現虧損
  let overseas: OverseasWatch | null = null;
  const { income } = await investIncomeForYear(String(year), st.baseCurrency, st.invest.costMethod);
  if (income.foreignDividend || income.foreignRealized || stocks.some((s) => !DOMESTIC.includes(s.market))) {
    const pf = buildPortfolio({ stocks, trades, prices, dividends, rates, base: st.baseCurrency, method: st.invest.costMethod, feeEstimate: makeFeeEstimate(st.invest) });
    const loss = pf.holdings.filter((h) => !DOMESTIC.includes(h.stock.market) && (h.val?.unrealizedBaseMinor ?? 0) < 0)
      .reduce((a, h) => a + Math.abs(fromMinor(h.val!.unrealizedBaseMinor, st.baseCurrency).toNumber()), 0);
    overseas = overseasWatch(income, params, Math.round(loss));
  }
  return { year, params, netIncomeSet: st.tax.netIncome > 0, events: analyses, overseas };
}

/** 除息前提醒：7 天內要除息、而且會被扣二代健保或值得評估棄息的，各通知一次（每個事件只通知一次） */
export async function notifyUpcomingDividends(): Promise<number> {
  const { events } = await loadTaxPlan();
  const today = todayKey(), soon = addDays(today, 7);
  const { adviceOf } = await import('@/domain/taxplan');
  let n = 0;
  for (const a of events) {
    const ex = a.event.exDate;
    if (a.event.source !== 'announced' || !ex || ex > soon || ex < today || (!a.nhi && a.recommendation !== 'consider_skip')) continue;
    await notify(`📅 ${a.event.symbol} 即將除息`, adviceOf(a).headline, '/reports/tax', 'subscription', `taxdiv:${a.event.stockId}:${ex}`);
    n++;
  }
  return n;
}

/** 首頁「需要你看一下」用：10 天內要除息、會被扣二代健保或值得評估的持股（先用便宜的查詢擋掉大多數情況） */
export async function taxAlertRows(today = todayKey()): Promise<{ key: string; text: string }[]> {
  const soon = addDays(today, 10);
  if ((await db.dividends.where('exDate').between(today, soon, true, true).filter((d) => d.status === 'announced' && d.kind === 'cash').count()) === 0) return [];
  const { events } = await loadTaxPlan(today);
  return events
    .filter((a) => a.event.source === 'announced' && a.event.exDate && a.event.exDate <= soon && (a.nhi > 0 || a.recommendation === 'consider_skip'))
    .slice(0, 2)
    .map((a) => ({ key: `taxdiv:${a.event.stockId}:${a.event.exDate}`, text: `${a.event.symbol} ${Number(a.event.exDate!.slice(5, 7))}/${Number(a.event.exDate!.slice(8))} 除息：預計配息 ${Math.round(a.event.gross).toLocaleString('zh-TW')} 元${a.nhi ? `，會扣二代健保 ${a.nhi} 元` : ''}，點開看建議` }));
}

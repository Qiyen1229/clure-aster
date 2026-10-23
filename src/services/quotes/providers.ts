/**
 * 可插拔報價資料源。每個資料源實作 QuoteProvider；registry 依使用者設定的優先順序呼叫並自動 fallback。
 *
 * 台股：twse-mis（即時）→ twse-openapi／tpex-openapi（收盤）→ finmind（日資料）→ yahoo
 * 美股：yahoo → finnhub → twelvedata → alphavantage（後三者需自備免費 API Key）
 */
import Decimal from 'decimal.js';
import type { Market } from '@/db/types';
import { useSettings } from '@/stores/settings';
import { getJson } from './http';

export interface StockRef { market: Market; symbol: string }
export interface Quote {
  market: Market;
  symbol: string;
  priceDec: string;
  prevCloseDec: string;
  openDec?: string;
  highDec?: string;
  lowDec?: string;
  volume?: number;
  marketTime: number;
  source: string;
  name?: string;
}
export interface Bar { t: number; date: string; close: number }
export type HistoryRange = '1d' | '1w' | '1m' | '3m' | '1y' | 'all';

export interface QuoteProvider {
  id: string;
  label: string;
  group: 'TW' | 'US' | 'ALL';
  keyName?: 'finnhub' | 'twelvedata' | 'alphavantage' | 'finmind';
  quote(refs: StockRef[]): Promise<Quote[]>;
  history?(ref: StockRef, range: HistoryRange): Promise<Bar[]>;
}

const num = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s || s === '-' || s === '--' || isNaN(Number(s))) return null;
  return new Decimal(s).toString();
};
const isTW = (m: Market) => m === 'TWSE' || m === 'TPEX' || m === 'EMERGING';
const keys = () => useSettings.getState().quote.keys;
/** 本地日期（FinMind 查詢起日用） */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Unix 秒 → 交易所當地日期（offset 為交易所 UTC 偏移秒數，Yahoo meta.gmtoffset） */
export function exchangeDateOf(unixSec: number, offsetSec: number): string {
  return new Date((unixSec + offsetSec) * 1000).toISOString().slice(0, 10);
}

/** Yahoo 代號：台股上市 2330.TW、上櫃／興櫃 6488.TWO、港股 0700.HK */
export function yahooSymbol(r: StockRef): string {
  if (r.market === 'TWSE') return `${r.symbol}.TW`;
  if (r.market === 'TPEX' || r.market === 'EMERGING') return `${r.symbol}.TWO`;
  if (r.market === 'HK') return `${r.symbol.padStart(4, '0')}.HK`;
  return r.symbol.toUpperCase();
}

// ───── 證交所即時（mis.twse.com.tw）─────
const twseMis: QuoteProvider = {
  id: 'twse-mis', label: '證交所即時（MIS）', group: 'TW',
  async quote(refs) {
    const tw = refs.filter((r) => r.market === 'TWSE' || r.market === 'TPEX');
    const out: Quote[] = [];
    for (let i = 0; i < tw.length; i += 40) {
      const chunk = tw.slice(i, i + 40);
      const exCh = chunk.map((r) => `${r.market === 'TPEX' ? 'otc' : 'tse'}_${r.symbol}.tw`).join('|');
      const j = await getJson(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`);
      for (const m of j.msgArray ?? []) {
        const prev = num(m.y);
        // z 為最近成交價；盤中無成交時為 '-'，改用最佳買價，再退回昨收
        const price = num(m.z) ?? num(String(m.b ?? '').split('_')[0]) ?? prev;
        if (!price || !prev) continue;
        out.push({
          market: m.ex === 'otc' ? 'TPEX' : 'TWSE', symbol: m.c, name: m.n, priceDec: price, prevCloseDec: prev,
          openDec: num(m.o) ?? undefined, highDec: num(m.h) ?? undefined, lowDec: num(m.l) ?? undefined,
          volume: m.v ? Number(m.v) * 1000 : undefined, marketTime: Number(m.tlong) || Date.now(), source: 'twse-mis',
        });
      }
    }
    return out;
  },
};

// ───── 證交所／櫃買 OpenAPI（每日收盤）─────
const twseOpenApi: QuoteProvider = {
  id: 'twse-openapi', label: '證交所／櫃買 OpenAPI（收盤）', group: 'TW',
  async quote(refs) {
    const out: Quote[] = [];
    const want = new Set(refs.map((r) => r.symbol));
    if (refs.some((r) => r.market === 'TWSE')) {
      const list = await getJson<any[]>('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
      for (const x of list) {
        if (!want.has(x.Code)) continue;
        const close = num(x.ClosingPrice);
        const chg = num(x.Change) ?? '0';
        if (!close) continue;
        out.push({
          market: 'TWSE', symbol: x.Code, name: x.Name, priceDec: close, prevCloseDec: new Decimal(close).minus(chg).toString(),
          openDec: num(x.OpeningPrice) ?? undefined, highDec: num(x.HighestPrice) ?? undefined, lowDec: num(x.LowestPrice) ?? undefined,
          volume: Number(x.TradeVolume) || undefined, marketTime: Date.now(), source: 'twse-openapi',
        });
      }
    }
    if (refs.some((r) => r.market === 'TPEX')) {
      const list = await getJson<any[]>('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes');
      for (const x of list) {
        if (!want.has(x.SecuritiesCompanyCode)) continue;
        const close = num(x.Close);
        const chg = num(x.Change) ?? '0';
        if (!close) continue;
        out.push({
          market: 'TPEX', symbol: x.SecuritiesCompanyCode, name: x.CompanyName, priceDec: close,
          prevCloseDec: new Decimal(close).minus(chg).toString(), openDec: num(x.Open) ?? undefined,
          highDec: num(x.High) ?? undefined, lowDec: num(x.Low) ?? undefined, marketTime: Date.now(), source: 'tpex-openapi',
        });
      }
    }
    return out;
  },
};

// ───── FinMind ─────
const finmind: QuoteProvider = {
  id: 'finmind', label: 'FinMind', group: 'TW', keyName: 'finmind',
  async quote(refs) {
    const out: Quote[] = [];
    const start = ymd(new Date(Date.now() - 14 * 86400000));
    for (const r of refs.filter((x) => isTW(x.market))) {
      const token = keys().finmind ? `&token=${encodeURIComponent(keys().finmind)}` : '';
      const j = await getJson(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${r.symbol}&start_date=${start}${token}`);
      const d = (j.data ?? []) as any[];
      if (d.length < 1) continue;
      const last = d[d.length - 1];
      const prev = d.length > 1 ? d[d.length - 2].close : last.close - (last.spread ?? 0);
      out.push({
        market: r.market, symbol: r.symbol, priceDec: String(last.close), prevCloseDec: String(prev),
        openDec: String(last.open), highDec: String(last.max), lowDec: String(last.min), volume: last.Trading_Volume,
        marketTime: Date.parse(`${last.date}T13:30:00+08:00`), source: 'finmind',
      });
    }
    return out;
  },
  async history(r, range) {
    const days = { '1d': 5, '1w': 10, '1m': 35, '3m': 100, '1y': 370, all: 3650 }[range];
    const token = keys().finmind ? `&token=${encodeURIComponent(keys().finmind)}` : '';
    const j = await getJson(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${r.symbol}&start_date=${ymd(new Date(Date.now() - days * 86400000))}${token}`);
    return (j.data ?? []).map((x: any) => ({ t: Date.parse(x.date), date: x.date, close: x.close }));
  },
};

// ───── Yahoo Finance（非官方）─────
const YAHOO_RANGE: Record<HistoryRange, [string, string]> = {
  '1d': ['1d', '5m'], '1w': ['5d', '30m'], '1m': ['1mo', '1d'], '3m': ['3mo', '1d'], '1y': ['1y', '1d'], all: ['max', '1wk'],
};
const yahoo: QuoteProvider = {
  id: 'yahoo', label: 'Yahoo Finance', group: 'ALL',
  async quote(refs) {
    const out: Quote[] = [];
    for (const r of refs) {
      const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(r))}?range=5d&interval=1d`);
      const meta = j.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) continue;
      const closes: number[] = (j.chart.result[0].indicators?.quote?.[0]?.close ?? []).filter((x: number | null) => x != null);
      // 5 日日線的倒數第二根即前一交易日收盤
      const prev = closes.length >= 2 ? closes[closes.length - 2] : meta.chartPreviousClose ?? meta.previousClose;
      out.push({
        market: r.market, symbol: r.symbol, name: meta.shortName ?? meta.longName, priceDec: String(meta.regularMarketPrice),
        prevCloseDec: String(prev ?? meta.regularMarketPrice), highDec: meta.regularMarketDayHigh ? String(meta.regularMarketDayHigh) : undefined,
        lowDec: meta.regularMarketDayLow ? String(meta.regularMarketDayLow) : undefined, volume: meta.regularMarketVolume,
        marketTime: (meta.regularMarketTime ?? Date.now() / 1000) * 1000, source: 'yahoo',
      });
    }
    return out;
  },
  async history(r, range) {
    const [rg, iv] = YAHOO_RANGE[range];
    const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(r))}?range=${rg}&interval=${iv}`);
    const res = j.chart?.result?.[0];
    if (!res) return [];
    const ts: number[] = res.timestamp ?? [];
    const close: (number | null)[] = res.indicators?.quote?.[0]?.close ?? [];
    // 以「交易所當地時區」換算日期（例：台股週線時間戳為台北 00:00 = UTC 前一天 16:00），與使用者所在時區無關
    const offset = Number(res.meta?.gmtoffset ?? 0);
    return ts.map((t, i) => ({ t: t * 1000, date: exchangeDateOf(t, offset), close: close[i] as number }))
      .filter((b) => b.close != null);
  },
};

// ───── Finnhub（需 Key，支援 CORS）─────
const finnhub: QuoteProvider = {
  id: 'finnhub', label: 'Finnhub', group: 'US', keyName: 'finnhub',
  async quote(refs) {
    const k = keys().finnhub;
    if (!k) return [];
    const out: Quote[] = [];
    for (const r of refs.filter((x) => x.market === 'US')) {
      const j = await getJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(r.symbol)}&token=${encodeURIComponent(k)}`, { direct: true });
      if (!j.c) continue;
      out.push({ market: r.market, symbol: r.symbol, priceDec: String(j.c), prevCloseDec: String(j.pc), openDec: String(j.o), highDec: String(j.h), lowDec: String(j.l), marketTime: (j.t || Date.now() / 1000) * 1000, source: 'finnhub' });
    }
    return out;
  },
};

// ───── Twelve Data（需 Key）─────
const twelvedata: QuoteProvider = {
  id: 'twelvedata', label: 'Twelve Data', group: 'US', keyName: 'twelvedata',
  async quote(refs) {
    const k = keys().twelvedata;
    if (!k) return [];
    const out: Quote[] = [];
    for (const r of refs.filter((x) => x.market === 'US')) {
      const j = await getJson(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(r.symbol)}&apikey=${encodeURIComponent(k)}`, { direct: true });
      if (!j.close) continue;
      out.push({ market: r.market, symbol: r.symbol, name: j.name, priceDec: String(j.close), prevCloseDec: String(j.previous_close), openDec: j.open, highDec: j.high, lowDec: j.low, volume: Number(j.volume) || undefined, marketTime: (Number(j.timestamp) || Date.now() / 1000) * 1000, source: 'twelvedata' });
    }
    return out;
  },
};

// ───── Alpha Vantage（需 Key）─────
const alphavantage: QuoteProvider = {
  id: 'alphavantage', label: 'Alpha Vantage', group: 'US', keyName: 'alphavantage',
  async quote(refs) {
    const k = keys().alphavantage;
    if (!k) return [];
    const out: Quote[] = [];
    for (const r of refs.filter((x) => x.market === 'US')) {
      const j = await getJson(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(r.symbol)}&apikey=${encodeURIComponent(k)}`, { direct: true });
      const q = j['Global Quote'];
      if (!q?.['05. price']) continue;
      out.push({ market: r.market, symbol: r.symbol, priceDec: num(q['05. price'])!, prevCloseDec: num(q['08. previous close'])!, marketTime: Date.parse(q['07. latest trading day']) || Date.now(), source: 'alphavantage' });
    }
    return out;
  },
};

export const PROVIDERS: QuoteProvider[] = [twseMis, twseOpenApi, finmind, yahoo, finnhub, twelvedata, alphavantage];
export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);

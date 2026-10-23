/**
 * 股票搜尋：
 * - 台股（上市／上櫃／興櫃／ETF）：FinMind TaiwanStockInfo（含產業）→ 證交所／櫃買 OpenAPI 名單；
 *   名單快取於 IndexedDB 7 天，離線時使用內建常用清單。
 * - 美股／港股：Yahoo 搜尋（經代理）。
 */
import { db } from '@/db/schema';
import type { Market, Stock } from '@/db/types';
import { getJson } from './http';

export interface StockMeta {
  market: Market;
  symbol: string;
  name: string;
  currency: string;
  assetType: Stock['assetType'];
  industry?: string;
}

const TTL = 7 * 86400000;

function twAssetType(code: string, industry?: string): Stock['assetType'] {
  if (/^00\d+B$/i.test(code)) return 'bond_etf';
  if (/^00/.test(code) || industry?.includes('ETF')) return 'etf';
  return 'stock';
}

/** 內建常用標的（離線或名單抓不到時使用） */
const BUILTIN: StockMeta[] = [
  ['2330', '台積電', '半導體業'], ['2317', '鴻海', '其他電子業'], ['2454', '聯發科', '半導體業'], ['2308', '台達電', '電子零組件業'],
  ['2412', '中華電', '通信網路業'], ['2881', '富邦金', '金融保險業'], ['2882', '國泰金', '金融保險業'], ['2891', '中信金', '金融保險業'],
  ['2886', '兆豐金', '金融保險業'], ['2884', '玉山金', '金融保險業'], ['2303', '聯電', '半導體業'], ['2002', '中鋼', '鋼鐵工業'],
  ['1301', '台塑', '塑膠工業'], ['2603', '長榮', '航運業'], ['3711', '日月光投控', '半導體業'], ['2382', '廣達', '電腦及週邊設備業'],
  ['0050', '元大台灣50', 'ETF'], ['0056', '元大高股息', 'ETF'], ['00878', '國泰永續高股息', 'ETF'], ['00919', '群益台灣精選高息', 'ETF'],
  ['006208', '富邦台50', 'ETF'], ['00929', '復華台灣科技優息', 'ETF'], ['00713', '元大台灣高息低波', 'ETF'], ['00679B', '元大美債20年', 'ETF'],
].map(([symbol, name, industry]): StockMeta => ({ market: 'TWSE', symbol, name, currency: 'TWD', assetType: twAssetType(symbol, industry), industry }))
  .concat([
    ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'NVIDIA'], ['GOOGL', 'Alphabet'], ['AMZN', 'Amazon'], ['META', 'Meta'],
    ['TSLA', 'Tesla'], ['TSM', 'TSMC ADR'], ['VOO', 'Vanguard S&P 500 ETF'], ['VTI', 'Vanguard Total Stock Market ETF'],
    ['QQQ', 'Invesco QQQ'], ['SPY', 'SPDR S&P 500 ETF'], ['BND', 'Vanguard Total Bond ETF'], ['VT', 'Vanguard Total World ETF'],
  ].map(([symbol, name]): StockMeta => ({ market: 'US', symbol, name, currency: 'USD', assetType: /ETF|QQQ/.test(name) ? 'etf' : 'stock' })));

async function twList(): Promise<StockMeta[]> {
  const cached = (await db.meta.get('twStockList'))?.value as { at: number; list: StockMeta[] } | undefined;
  if (cached && Date.now() - cached.at < TTL && cached.list.length > 500) return cached.list;
  if (!navigator.onLine) return cached?.list ?? [];
  let list: StockMeta[] = [];
  try {
    const j = await getJson('https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo', { timeoutMs: 15000, retries: 1 });
    const seen = new Set<string>();
    for (const x of j.data ?? []) {
      if (seen.has(x.stock_id)) continue;
      seen.add(x.stock_id);
      const market: Market = x.type === 'tpex' ? 'TPEX' : x.type === 'emerging' ? 'EMERGING' : 'TWSE';
      list.push({ market, symbol: x.stock_id, name: x.stock_name, currency: 'TWD', assetType: twAssetType(x.stock_id, x.industry_category), industry: x.industry_category });
    }
  } catch { /* 改用 OpenAPI */ }
  if (list.length < 500) {
    try {
      const [twse, tpex] = await Promise.all([
        getJson<any[]>('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { retries: 1 }),
        getJson<any[]>('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { retries: 1 }).catch(() => []),
      ]);
      list = [
        ...twse.map((x) => ({ market: 'TWSE' as Market, symbol: x.Code, name: x.Name, currency: 'TWD', assetType: twAssetType(x.Code) })),
        ...tpex.map((x) => ({ market: 'TPEX' as Market, symbol: x.SecuritiesCompanyCode, name: x.CompanyName, currency: 'TWD', assetType: twAssetType(x.SecuritiesCompanyCode) })),
      ];
    } catch { /* 全部失敗 */ }
  }
  if (list.length) await db.meta.put({ key: 'twStockList', value: { at: Date.now(), list } });
  return list.length ? list : cached?.list ?? [];
}

async function yahooSearch(q: string): Promise<StockMeta[]> {
  const j = await getJson(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`, { retries: 1 });
  const out: StockMeta[] = [];
  for (const x of j.quotes ?? []) {
    if (!['EQUITY', 'ETF'].includes(x.quoteType)) continue;
    const sym: string = x.symbol;
    if (sym.endsWith('.TW') || sym.endsWith('.TWO')) continue; // 台股走本地名單
    if (sym.endsWith('.HK')) out.push({ market: 'HK', symbol: sym.replace('.HK', ''), name: x.shortname ?? x.longname ?? sym, currency: 'HKD', assetType: x.quoteType === 'ETF' ? 'etf' : 'stock', industry: x.industry });
    else if (!sym.includes('.')) out.push({ market: 'US', symbol: sym, name: x.shortname ?? x.longname ?? sym, currency: 'USD', assetType: x.quoteType === 'ETF' ? 'etf' : 'stock', industry: x.industry ?? x.sector });
  }
  return out;
}

/** 搜尋代號或名稱。台股名單在本機比對，美股即時查詢 */
export async function searchStocks(q: string): Promise<StockMeta[]> {
  const k = q.trim();
  if (!k) return [];
  const lower = k.toLowerCase();
  const tw = await twList().catch(() => [] as StockMeta[]);
  const pool = [...tw, ...BUILTIN.filter((b) => !tw.some((t) => t.symbol === b.symbol && t.market === b.market))];
  const local = pool
    .filter((s) => s.symbol.toLowerCase().startsWith(lower) || s.name.toLowerCase().includes(lower))
    .sort((a, b) => (a.symbol.toLowerCase() === lower ? -1 : b.symbol.toLowerCase() === lower ? 1 : a.symbol.length - b.symbol.length))
    .slice(0, 20);
  let remote: StockMeta[] = [];
  if (/[a-z]/i.test(k) && navigator.onLine) remote = await yahooSearch(k).catch(() => []);
  const seen = new Set(local.map((s) => `${s.market}:${s.symbol}`));
  return [...local, ...remote.filter((r) => !seen.has(`${r.market}:${r.symbol}`))].slice(0, 30);
}

/** 補產業別（從名單） */
export async function lookupIndustry(market: Market, symbol: string): Promise<string | undefined> {
  const tw = await twList().catch(() => []);
  return tw.find((s) => s.symbol === symbol && s.market === market)?.industry;
}

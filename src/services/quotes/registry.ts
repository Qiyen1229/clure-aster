/**
 * 報價調度：依優先順序呼叫資料源、自動 fallback、熔斷（連續失敗 3 次冷卻 5 分鐘）、
 * 成功報價寫入 IndexedDB price_cache；全部失敗時保留最後一次價格並標示「非最新」。
 */
import { db } from '@/db/schema';
import type { PriceCache, Stock } from '@/db/types';
import { useSettings } from '@/stores/settings';
import { marketGroup } from '@/domain/invest/market-hours';
import { PROVIDERS, providerById, type Bar, type HistoryRange, type Quote, type StockRef } from './providers';

const breaker = new Map<string, { fails: number; until: number }>();
const COOLDOWN = 5 * 60 * 1000;

function available(id: string) {
  const b = breaker.get(id);
  return !b || b.until < Date.now();
}
function fail(id: string) {
  const b = breaker.get(id) ?? { fails: 0, until: 0 };
  b.fails++;
  if (b.fails >= 3) { b.until = Date.now() + COOLDOWN; b.fails = 0; }
  breaker.set(id, b);
}
function ok(id: string) { breaker.delete(id); }

export interface RefreshResult { updated: number; failed: Stock[]; sources: Set<string>; errors: string[] }

/** 把各資料源的錯誤整理成一句使用者看得懂的原因 */
export function describeQuoteErrors(errors: string[]): string {
  if (!errors.length) return '所有資料源皆失敗';
  if (errors.some((e) => /HTTP 401/.test(e))) return '報價代理拒絕存取：請重新整理或重新登入；若有設定代理權杖，請確認與 NAS 上的 PROXY_ACCESS_TOKEN 相同';
  if (errors.some((e) => /Failed to fetch|NetworkError|Load failed|無法連線/.test(e))) return '無法連到報價代理：若代理網址不是同源的 /proxy，請確認網址正確且已加入 CSP 的 connect-src';
  if (errors.every((e) => /HTTP 429/.test(e))) return '資料源暫時限流（429），請稍後再試或在設定中填入 Finnhub／Twelve Data API Key';
  return [...new Set(errors)].slice(0, 3).join('；');
}

let inflight: Promise<RefreshResult> | null = null;

/** 更新多檔報價（同時間只會有一個更新在跑） */
export function refreshQuotes(stocks: Stock[]): Promise<RefreshResult> {
  if (inflight) return inflight;
  inflight = doRefresh(stocks).finally(() => { inflight = null; });
  return inflight;
}

async function doRefresh(stocks: Stock[]): Promise<RefreshResult> {
  const { twOrder, usOrder } = useSettings.getState().quote;
  const result: RefreshResult = { updated: 0, failed: [], sources: new Set(), errors: [] };
  if (!navigator.onLine) { result.failed = stocks; result.errors.push('目前離線'); return result; }
  const groups: Record<'TW' | 'US' | 'HK', Stock[]> = { TW: [], US: [], HK: [] };
  for (const s of stocks) groups[marketGroup(s.market)].push(s);

  for (const [g, list] of Object.entries(groups) as ['TW' | 'US' | 'HK', Stock[]][]) {
    if (!list.length) continue;
    let remaining = [...list];
    const order = g === 'TW' ? twOrder : g === 'US' ? usOrder : ['yahoo'];
    for (const pid of order) {
      if (!remaining.length) break;
      const p = providerById(pid);
      if (!p || !available(pid)) continue;
      try {
        const quotes = await p.quote(remaining.map((s) => ({ market: s.market, symbol: s.symbol })));
        if (quotes.length) ok(pid);
        const got = await saveQuotes(remaining, quotes);
        if (got.size) result.sources.add(p.label);
        result.updated += got.size;
        remaining = remaining.filter((s) => !got.has(s.id));
      } catch (e) {
        fail(pid);
        result.errors.push(`${p.label}：${(e as Error).message}`);
      }
    }
    result.failed.push(...remaining);
  }
  await db.meta.put({ key: 'quotesUpdatedAt', value: Date.now() });
  return result;
}

async function saveQuotes(stocks: Stock[], quotes: Quote[]): Promise<Set<string>> {
  const got = new Set<string>();
  const rows: PriceCache[] = [];
  for (const q of quotes) {
    const s = stocks.find((x) => x.symbol === q.symbol && (x.market === q.market || marketGroup(x.market) === marketGroup(q.market)));
    if (!s || got.has(s.id)) continue;
    const price = Number(q.priceDec), prev = Number(q.prevCloseDec);
    if (!(price > 0)) continue;
    got.add(s.id);
    rows.push({
      stockId: s.id, priceDec: q.priceDec, prevCloseDec: q.prevCloseDec,
      changeDec: String(+(price - prev).toFixed(6)), changePctDec: prev ? String(+(((price - prev) / prev) * 100).toFixed(4)) : '0',
      openDec: q.openDec, highDec: q.highDec, lowDec: q.lowDec, volume: q.volume, marketTime: q.marketTime,
      source: q.source, updatedAt: Date.now(), isManual: false,
    });
  }
  if (rows.length) await db.price_cache.bulkPut(rows);
  return got;
}

/** 手動輸入現價（所有資料源都失敗時） */
export async function setManualPrice(stockId: string, priceDec: string) {
  const old = await db.price_cache.get(stockId);
  const prev = old?.prevCloseDec ?? priceDec;
  await db.price_cache.put({
    stockId, priceDec, prevCloseDec: prev, changeDec: String(Number(priceDec) - Number(prev)),
    changePctDec: Number(prev) ? String(((Number(priceDec) - Number(prev)) / Number(prev)) * 100) : '0',
    marketTime: Date.now(), source: 'manual', updatedAt: Date.now(), isManual: true,
  });
}

/** 走勢資料：Yahoo → FinMind（台股日線）；日線結果寫入 price_history 供離線使用 */
export async function fetchHistory(stock: Stock, range: HistoryRange): Promise<{ bars: Bar[]; source: string; offline: boolean }> {
  const ref: StockRef = { market: stock.market, symbol: stock.symbol };
  const order = marketGroup(stock.market) === 'TW' ? ['yahoo', 'finmind'] : ['yahoo'];
  for (const pid of order) {
    const p = PROVIDERS.find((x) => x.id === pid);
    if (!p?.history || !available(pid) || !navigator.onLine) continue;
    try {
      const bars = await p.history(ref, range);
      if (bars.length) {
        if (range !== '1d' && range !== '1w') {
          await db.price_history.bulkPut(bars.map((b) => ({ stockId: stock.id, date: b.date, closeDec: String(b.close) })));
        }
        return { bars, source: p.label, offline: false };
      }
    } catch { fail(pid); }
  }
  // 離線：用已快取的日線
  const cached = await db.price_history.where('stockId').equals(stock.id).sortBy('date');
  return { bars: cached.map((c) => ({ t: Date.parse(c.date), date: c.date, close: Number(c.closeDec) })), source: '快取', offline: true };
}

export interface SourceCheck { id: string; label: string; ok: boolean; ms: number; detail: string }

/**
 * 診斷各資料源：用 2330（台股）與 AAPL（美股）各打一次，回報成功與否、花多久、拿到什麼價與資料時間，
 * 失敗則附原因。不經過熔斷器與優先順序，直接測每一個。需要 Key 的資料源沒填 Key 會標示略過。
 */
export async function diagnoseSources(): Promise<SourceCheck[]> {
  const keys = useSettings.getState().quote.keys;
  const out: SourceCheck[] = [];
  for (const p of PROVIDERS) {
    if (p.keyName && !keys[p.keyName]) { out.push({ id: p.id, label: p.label, ok: false, ms: 0, detail: '未填 API Key，略過' }); continue; }
    const ref: StockRef = p.group === 'US' ? { market: 'US', symbol: 'AAPL' } : { market: 'TWSE', symbol: '2330' };
    const t0 = Date.now();
    try {
      const q = (await p.quote([ref]))[0];
      const ms = Date.now() - t0;
      if (!q) out.push({ id: p.id, label: p.label, ok: false, ms, detail: `連線成功但沒有 ${ref.symbol} 的報價` });
      else out.push({ id: p.id, label: p.label, ok: true, ms, detail: `${ref.symbol} ${q.priceDec}（昨收 ${q.prevCloseDec}）・資料時間 ${new Date(q.marketTime).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}` });
    } catch (e) {
      out.push({ id: p.id, label: p.label, ok: false, ms: Date.now() - t0, detail: (e as Error).message });
    }
  }
  return out;
}

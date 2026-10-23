/**
 * 匯率服務：open.er-api.com（主）→ fawazahmed0 currency-api（備援，jsDelivr CDN）。
 * 皆為免費、免金鑰、支援 CORS。手動覆蓋的匯率（source='manual'）不會被自動更新蓋掉。
 */
import Decimal from 'decimal.js';
import { db } from '@/db/schema';
import type { ExchangeRate } from '@/db/types';

const STALE_MS = 12 * 60 * 60 * 1000;

type RateMap = Map<string, ExchangeRate>;
const keyOf = (b: string, q: string) => `${b}>${q}`;

async function loadMap(): Promise<RateMap> {
  const rows = await db.exchange_rates.toArray();
  return new Map(rows.map((r) => [keyOf(r.base, r.quote), r]));
}

/** 由已存匯率表推算 from→to：直接、反向、或經由任一共同基準三角換算 */
export function resolveRate(map: RateMap, from: string, to: string): Decimal | null {
  if (from === to) return new Decimal(1);
  const direct = map.get(keyOf(from, to));
  if (direct) return new Decimal(direct.rateDec);
  const inverse = map.get(keyOf(to, from));
  if (inverse && !new Decimal(inverse.rateDec).isZero()) return new Decimal(1).div(inverse.rateDec);
  // 三角換算：from→P 已知，再找 to→P 或 P→to
  for (const r of map.values()) {
    if (r.base !== from) continue;
    const pivot = r.quote;
    const toPivot = map.get(keyOf(to, pivot));
    if (toPivot && !new Decimal(toPivot.rateDec).isZero()) return new Decimal(r.rateDec).div(toPivot.rateDec);
    const pivotTo = map.get(keyOf(pivot, to));
    if (pivotTo) return new Decimal(r.rateDec).mul(pivotTo.rateDec);
  }
  return null;
}

export async function getRate(from: string, to: string): Promise<Decimal | null> {
  if (from === to) return new Decimal(1);
  let rate = resolveRate(await loadMap(), from, to);
  if (!rate && navigator.onLine) {
    await refreshRates(to).catch(() => undefined);
    rate = resolveRate(await loadMap(), from, to);
  }
  return rate;
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 抓取以 base 為基準的全部匯率並寫入 DB；回傳更新筆數 */
export async function refreshRates(base: string): Promise<number> {
  let rates: Record<string, number> | null = null;
  try {
    const j = await fetchJson(`https://open.er-api.com/v6/latest/${base}`);
    if (j.result === 'success') rates = j.rates;
  } catch { /* 改用備援 */ }
  if (!rates) {
    const b = base.toLowerCase();
    const j = await fetchJson(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${b}.json`);
    rates = Object.fromEntries(Object.entries(j[b] as Record<string, number>).map(([k, v]) => [k.toUpperCase(), v]));
  }
  const manual = new Set(
    (await db.exchange_rates.toArray()).filter((r) => r.source === 'manual').map((r) => keyOf(r.base, r.quote)),
  );
  const now = Date.now();
  // 匯率以「1 quote = ? base」方向儲存（例：USD→TWD 32.1），方便換算為主幣別
  const rows: ExchangeRate[] = Object.entries(rates)
    .filter(([q, v]) => q !== base && v > 0 && !manual.has(keyOf(q, base)))
    .map(([q, v]) => ({ base: q, quote: base, rateDec: new Decimal(1).div(v).toSignificantDigits(10).toString(), source: 'api', updatedAt: now }));
  await db.exchange_rates.bulkPut(rows);
  await db.meta.put({ key: 'fxUpdatedAt', value: now });
  return rows.length;
}

export async function refreshRatesIfStale(base: string): Promise<void> {
  const last = (await db.meta.get('fxUpdatedAt'))?.value as number | undefined;
  if (!navigator.onLine || (last && Date.now() - last < STALE_MS)) return;
  await refreshRates(base).catch((e) => console.warn('[fx] 更新失敗', e));
}

export async function setManualRate(from: string, to: string, rateDec: string): Promise<void> {
  await db.exchange_rates.put({ base: from, quote: to, rateDec, source: 'manual', updatedAt: Date.now() });
}

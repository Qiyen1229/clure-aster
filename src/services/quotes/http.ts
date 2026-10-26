/**
 * 報價用 HTTP：經由 CORS 代理（NAS Docker 同源 /proxy 或 Cloudflare Worker），
 * 含逾時、重試（指數退避）、每個網域的最小請求間隔（節流）。
 */
import { useSettings } from '@/stores/settings';

const lastHit = new Map<string, number>();
const MIN_INTERVAL: Record<string, number> = {
  'mis.twse.com.tw': 1500, // 證交所對頻繁請求會暫時封鎖
  'www.alphavantage.co': 13000, // 免費版每分鐘 5 次
  default: 250,
};

async function throttle(host: string) {
  const gap = MIN_INTERVAL[host] ?? MIN_INTERVAL.default;
  const wait = (lastHit.get(host) ?? 0) + gap - Date.now();
  lastHit.set(host, Math.max(Date.now(), (lastHit.get(host) ?? 0) + gap));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

export function proxied(url: string): { url: string; headers: Record<string, string> } {
  const { proxyUrl, proxyToken } = useSettings.getState().quote;
  const base = (proxyUrl || '/proxy').replace(/\/$/, '');
  return {
    url: `${base}/fetch?url=${encodeURIComponent(url)}`,
    headers: proxyToken ? { 'x-clure-token': proxyToken } : {},
  };
}

/**
 * NAS 的 /proxy/ 只允許已登入的使用者（nginx auth_request）。Access Token 過期時代理會回 401：
 * 先透過帳號 API 刷新登入（/auth/me 會自動 refresh）再重試一次。同時多個請求只刷新一次。
 */
let refreshing: Promise<boolean> | null = null;
async function refreshLogin(): Promise<boolean> {
  refreshing ??= import('../api')
    .then(({ api }) => api('/auth/me'))
    .then(() => true, () => false)
    .finally(() => setTimeout(() => { refreshing = null; }, 0));
  return refreshing;
}

/**
 * 取得 JSON。direct=true 時直接呼叫（對方支援 CORS，例如 Finnhub），失敗再改走代理。
 */
export async function getJson<T = any>(url: string, opts: { direct?: boolean; retries?: number; timeoutMs?: number } = {}): Promise<T> {
  const { direct = false, retries = 2, timeoutMs = 9000 } = opts;
  const host = new URL(url).host;
  let lastErr: unknown;
  let reauthed = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await throttle(host);
      const useDirect = direct && attempt === 0;
      const target = useDirect ? { url, headers: {} } : proxied(url);
      let res = await fetchWithTimeout(target.url, { headers: target.headers }, timeoutMs);
      if (res.status === 401 && !useDirect && !reauthed && target.url.startsWith('/')) {
        reauthed = true;
        if (await refreshLogin()) res = await fetchWithTimeout(target.url, { headers: target.headers }, timeoutMs);
      }
      if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text) as T;
    } catch (e) {
      lastErr = e;
      // 4xx（除了 429）不重試
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Aster 報價代理核心（Cloudflare Workers、Node、Vite 開發伺服器共用）。
 *
 * 只做一件事：把瀏覽器無法直接呼叫（沒有 CORS）的「白名單」金融資料網址代為取回，並加上 CORS 標頭。
 *   GET /fetch?url=<encoded target>   → 轉發（只允許 GET、只允許白名單網域）
 *   GET /health                        → ok
 * 安全：
 *   - 白名單網域，杜絕被當成任意開放代理
 *   - 選用 ACCESS_TOKEN（請求帶 x-clure-token 標頭；不接受網址參數，避免權杖出現在存取日誌）
 *   - 每個 IP 每分鐘 120 次的簡易速率限制
 *   - 不記錄任何請求內容（API Key 會出現在目標網址的查詢字串中）
 */

export interface ProxyEnv {
  ACCESS_TOKEN?: string;
  /** 允許的來源，預設 *；可設為 https://aster.example.com */
  ALLOW_ORIGIN?: string;
}

export interface CacheLike {
  get(key: string): Promise<Response | undefined>;
  put(key: string, res: Response, ttlSec: number): Promise<void>;
}

export const ALLOWED_HOSTS = [
  'mis.twse.com.tw',
  'openapi.twse.com.tw',
  'www.twse.com.tw',
  'www.tpex.org.tw',
  'api.finmindtrade.com',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'finnhub.io',
  'api.twelvedata.com',
  'www.alphavantage.co',
  'open.er-api.com',
];

/** 不同來源的快取秒數（盤中即時報價短、名單長） */
function ttlFor(url: URL): number {
  if (url.host === 'mis.twse.com.tw') return 10;
  if (url.pathname.includes('TaiwanStockInfo') || url.pathname.includes('STOCK_DAY_ALL') || url.pathname.includes('daily_close_quotes')) return 1800;
  if (url.pathname.includes('/search')) return 300;
  if (url.host.includes('yahoo')) return 20;
  return 30;
}

/** 定長比較，避免以回應時間猜測權杖 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const hits = new Map<string, { n: number; reset: number }>();
function rateLimited(ip: string, limit = 120): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) { hits.set(ip, { n: 1, reset: now + 60000 }); return false; }
  h.n++;
  if (hits.size > 5000) hits.clear();
  return h.n > limit;
}

function cors(env: ProxyEnv, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'x-clure-token, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...extra,
  };
}

function json(status: number, body: unknown, env: ProxyEnv): Response {
  return new Response(JSON.stringify(body), { status, headers: cors(env, { 'content-type': 'application/json; charset=utf-8' }) });
}

export async function handle(req: Request, env: ProxyEnv, opts: { ip?: string; cache?: CacheLike; basePath?: string } = {}): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  if (req.method !== 'GET') return json(405, { error: 'method not allowed' }, env);
  const u = new URL(req.url);
  let path = u.pathname;
  if (opts.basePath && path.startsWith(opts.basePath)) path = path.slice(opts.basePath.length) || '/';
  if (path === '/health' || path === '/') return json(200, { ok: true, service: 'clure-quote-proxy' }, env);
  if (path !== '/fetch') return json(404, { error: 'not found' }, env);

  if (env.ACCESS_TOKEN) {
    const token = req.headers.get('x-clure-token') ?? '';
    if (!safeEqual(token, env.ACCESS_TOKEN)) return json(401, { error: 'invalid token' }, env);
  }
  if (rateLimited(opts.ip ?? 'anon')) return json(429, { error: 'too many requests' }, env);

  let target: URL;
  try { target = new URL(u.searchParams.get('url') ?? ''); } catch { return json(400, { error: 'invalid url' }, env); }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.includes(target.host)) return json(403, { error: `host not allowed: ${target.host}` }, env);

  const cacheKey = `https://aster-cache/${encodeURIComponent(target.toString())}`;
  if (opts.cache) {
    const hit = await opts.cache.get(cacheKey);
    if (hit) return new Response(hit.body, { status: hit.status, headers: cors(env, { 'content-type': hit.headers.get('content-type') ?? 'application/json', 'x-cache': 'HIT' }) });
  }

  const headers: Record<string, string> = {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
  };
  if (target.host === 'mis.twse.com.tw') headers.referer = 'https://mis.twse.com.tw/stock/index.jsp';
  if (target.host.endsWith('finance.yahoo.com')) {
    const cookie = await yahooCookie(headers['user-agent']);
    if (cookie) headers.cookie = cookie;
  }

  let upstream: Response;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    upstream = await fetch(target.toString(), { headers, signal: ctl.signal, redirect: 'follow' });
    clearTimeout(timer);
  } catch (e) {
    // 連不上外網（DNS、IPv6、防火牆、逾時）時，把原因帶回去並寫進容器日誌；只記網域，不記查詢字串（可能含 API Key）
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const reason = [err.name === 'AbortError' ? '逾時（12 秒內沒有回應）' : err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join(' / ');
    console.warn(`[proxy] 連不上 ${target.host}：${reason}`);
    return json(502, { error: 'upstream fetch failed', detail: `${target.host}：${reason}` }, env);
  }
  const body = await upstream.arrayBuffer();
  const ct = upstream.headers.get('content-type') ?? 'application/json';
  const res = new Response(body, { status: upstream.status, headers: cors(env, { 'content-type': ct, 'cache-control': `public, max-age=${ttlFor(target)}`, 'x-cache': 'MISS' }) });
  if (opts.cache && upstream.ok) await opts.cache.put(cacheKey, new Response(body, { status: upstream.status, headers: { 'content-type': ct } }), ttlFor(target));
  return res;
}

/** Yahoo 需要先取得 A3 cookie（由 fc.yahoo.com 設定），快取 1 小時；取得失敗則不帶 cookie */
let yCookie: { v: string; exp: number } | null = null;
async function yahooCookie(ua: string): Promise<string | null> {
  if (yCookie && yCookie.exp > Date.now()) return yCookie.v;
  try {
    const r = await fetch('https://fc.yahoo.com', { headers: { 'user-agent': ua }, redirect: 'manual' });
    const list = typeof (r.headers as any).getSetCookie === 'function' ? (r.headers as any).getSetCookie() as string[] : [r.headers.get('set-cookie') ?? ''];
    const v = list.map((c) => c.split(';')[0]).filter((c) => c.startsWith('A3=') || c.startsWith('A1=')).join('; ');
    yCookie = { v, exp: Date.now() + 3600000 };
    return v || null;
  } catch {
    return null;
  }
}

/** Node / Vite 用的記憶體快取 */
export function memoryCache(max = 500): CacheLike {
  const store = new Map<string, { exp: number; status: number; ct: string; body: ArrayBuffer }>();
  return {
    async get(key) {
      const v = store.get(key);
      if (!v) return undefined;
      if (v.exp < Date.now()) { store.delete(key); return undefined; }
      return new Response(v.body.slice(0), { status: v.status, headers: { 'content-type': v.ct } });
    },
    async put(key, res, ttl) {
      if (store.size >= max) store.delete(store.keys().next().value as string);
      store.set(key, { exp: Date.now() + ttl * 1000, status: res.status, ct: res.headers.get('content-type') ?? '', body: await res.arrayBuffer() });
    },
  };
}

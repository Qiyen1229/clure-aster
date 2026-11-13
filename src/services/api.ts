/**
 * 後端 API 用戶端：
 * - 同源 /api，Cookie 由瀏覽器自動帶（Access／Refresh Token 皆為 HttpOnly，前端碰不到）
 * - 非 GET 請求自動附上 X-CSRF-Token（double-submit）
 * - 401 時自動呼叫 /auth/refresh 一次（多個請求同時 401 只刷新一次），失敗則通知登出
 */
export class ApiError extends Error {
  constructor(public status: number, message: string, /** 伺服器要求雙因素驗證碼（登入時密碼對了、但還要驗證碼） */ public totpRequired = false) {
    super(message);
  }
}

const BASE = '/api';
const NO_AUTO_REFRESH = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];
type RefreshResult = 'ok' | 'unauth' | 'transient';
let onUnauthorized: (() => void) | null = null;
let refreshing: Promise<RefreshResult> | null = null;

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/** HTTPS 時 Cookie 名稱帶 `__Host-` 前綴（防子網域 Cookie Tossing），HTTP 沒有 */
function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)(?:__Host-)?csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function ensureCsrf(): Promise<void> {
  if (!csrfToken()) await fetch(`${BASE}/health`, { credentials: 'same-origin', cache: 'no-store' }).catch(() => undefined);
}

async function refreshOnce(): Promise<RefreshResult> {
  refreshing ??= (async (): Promise<RefreshResult> => {
    try {
      await ensureCsrf();
      let r = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-CSRF-Token': csrfToken() } });
      if (r.status === 403) {
        const data = await r.clone().json().catch(() => null);
        if (typeof data?.detail === 'string' && data.detail.includes('安全驗證')) {
          document.cookie = 'csrf_token=; Max-Age=0; path=/';
          document.cookie = '__Host-csrf_token=; Max-Age=0; path=/; Secure';
          await ensureCsrf();
          r = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-CSRF-Token': csrfToken() } });
        }
      }
      if (r.ok) return 'ok';
      // 5xx 或限流（429）屬於暫時性問題，不應把使用者強制登出
      if (r.status >= 500 || r.status === 429) return 'transient';
      return 'unauth';
    } catch {
      // 斷網、逾時或 NAS 喚醒中：保留本機登入狀態，由離線模式接手
      return 'transient';
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}, retry = true): Promise<T> {
  const method = opts.method ?? 'GET';
  if (method !== 'GET') await ensureCsrf();
  const qs = opts.query
    ? '?' + Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
    : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}${qs}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken() } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    if (controller.signal.aborted && !opts.signal?.aborted) {
      throw new ApiError(0, '連線逾時，請檢查網路後重試');
    }
    throw new ApiError(0, '無法連線到伺服器，請檢查網路');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 && retry && !NO_AUTO_REFRESH.includes(path)) {
    const ref = await refreshOnce();
    if (ref === 'ok') return api<T>(path, opts, false);
    if (ref === 'transient') throw new ApiError(0, '無法連線到伺服器，請檢查網路');
    onUnauthorized?.();
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // CSRF Cookie 遺失（例如被清除）：重新取得後再試一次
    if (res.status === 403 && retry && typeof data?.detail === 'string' && data.detail.includes('安全驗證')) {
      document.cookie = 'csrf_token=; Max-Age=0; path=/';
      document.cookie = '__Host-csrf_token=; Max-Age=0; path=/; Secure';
      await ensureCsrf();
      return api<T>(path, opts, false);
    }
    throw new ApiError(res.status, typeof data?.detail === 'string' ? data.detail : res.status >= 500 ? `伺服器暫時沒有回應（${res.status}），請稍後再試` : res.status === 404 ? '找不到這筆資料' : `發生錯誤（${res.status}），請稍後再試`, res.headers.get('X-Totp-Required') === '1');
  }
  return data as T;
}

/** 瀏覽器不支援讀取串流回應（沒有 response.body）：呼叫端要改用一般的非串流呼叫 */
export class StreamUnsupported extends Error {}

/**
 * POST 後讀取事件流（SSE）：伺服器一邊生成一邊送，每收到一個事件就呼叫 onEvent(事件名稱, 資料)。
 * 回傳 `done` 事件的資料；收到 `error` 事件、或串流沒有以 done 結束，會丟出 ApiError。
 * 開始串流之前的錯誤（沒登入、額度用完、格式錯誤）是一般的 JSON 錯誤回應，處理方式和 api() 一樣（含自動刷新登入）。
 */
export async function apiSse<T>(
  path: string,
  body: unknown,
  onEvent: (name: string, data: any) => void,
  retry = true,
  idleTimeoutMs = 120000,
): Promise<T> {
  await ensureCsrf();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleTimeoutMs);
  };
  resetTimer();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
      body: JSON.stringify(body),
    });
  } catch {
    if (timer) clearTimeout(timer);
    if (controller.signal.aborted) throw new ApiError(0, '連線逾時，請檢查網路後重試');
    throw new ApiError(0, '無法連線到伺服器，請檢查網路');
  }
  if (res.status === 401 && retry) {
    if (timer) clearTimeout(timer);
    const ref = await refreshOnce();
    if (ref === 'ok') return apiSse<T>(path, body, onEvent, false, idleTimeoutMs);
    if (ref === 'transient') throw new ApiError(0, '無法連線到伺服器，請檢查網路');
    onUnauthorized?.();
  }
  if (!res.ok) {
    if (timer) clearTimeout(timer);
    const data = await res.json().catch(() => null);
    if (res.status === 403 && retry && typeof data?.detail === 'string' && data.detail.includes('安全驗證')) {
      document.cookie = 'csrf_token=; Max-Age=0; path=/';
      document.cookie = '__Host-csrf_token=; Max-Age=0; path=/; Secure';
      await ensureCsrf();
      return apiSse<T>(path, body, onEvent, false, idleTimeoutMs);
    }
    throw new ApiError(res.status, typeof data?.detail === 'string' ? data.detail : res.status >= 500 ? `伺服器暫時沒有回應（${res.status}），請稍後再試` : `發生錯誤（${res.status}），請稍後再試`);
  }
  if (!res.body) {
    if (timer) clearTimeout(timer);
    throw new StreamUnsupported();
  }
  const reader = res.body.getReader();
  const onAbort = () => {
    try { reader.cancel(); } catch { /* ignore */ }
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder();
  let buf = '';
  let result: T | undefined;
  const handle = (block: string) => {
    let name = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    if (name === 'error') {
      const e = parsed as { status?: number; detail?: string };
      throw new ApiError(e.status ?? 500, e.detail ?? '發生錯誤，請稍後再試');
    }
    if (name === 'done') result = parsed as T;
    onEvent(name, parsed);
  };
  try {
    for (;;) {
      resetTimer();
      const { done, value } = await reader.read();
      if (done) break;
      resetTimer();
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) !== -1) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
    if (buf.trim()) handle(buf);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (controller.signal.aborted) throw new ApiError(0, '連線逾時，請檢查網路後重試');
    throw new ApiError(0, '連線中斷了，請檢查網路後再試一次');
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
  if (controller.signal.aborted) throw new ApiError(0, '連線逾時，請檢查網路後重試');
  if (result === undefined) throw new ApiError(502, '回答中斷了，請再試一次');
  return result;
}

/**
 * 後端 API 用戶端：
 * - 同源 /api，Cookie 由瀏覽器自動帶（Access／Refresh Token 皆為 HttpOnly，前端碰不到）
 * - 非 GET 請求自動附上 X-CSRF-Token（double-submit）
 * - 401 時自動呼叫 /auth/refresh 一次（多個請求同時 401 只刷新一次），失敗則通知登出
 */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const BASE = '/api';
const NO_AUTO_REFRESH = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];
let onUnauthorized: (() => void) | null = null;
let refreshing: Promise<boolean> | null = null;

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function ensureCsrf(): Promise<void> {
  if (!csrfToken()) await fetch(`${BASE}/health`, { credentials: 'same-origin', cache: 'no-store' }).catch(() => undefined);
}

async function refreshOnce(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      await ensureCsrf();
      const r = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken() } });
      return r.ok;
    } catch {
      return false;
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
}

export async function api<T>(path: string, opts: RequestOptions = {}, retry = true): Promise<T> {
  const method = opts.method ?? 'GET';
  if (method !== 'GET') await ensureCsrf();
  const qs = opts.query
    ? '?' + Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
    : '';
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}${qs}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken() } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, '無法連線到伺服器，請檢查網路');
  }
  if (res.status === 401 && retry && !NO_AUTO_REFRESH.includes(path)) {
    if (await refreshOnce()) return api<T>(path, opts, false);
    onUnauthorized?.();
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // CSRF Cookie 遺失（例如被清除）：重新取得後再試一次
    if (res.status === 403 && retry && typeof data?.detail === 'string' && data.detail.includes('安全驗證')) {
      document.cookie = 'csrf_token=; Max-Age=0; path=/';
      await ensureCsrf();
      return api<T>(path, opts, false);
    }
    throw new ApiError(res.status, typeof data?.detail === 'string' ? data.detail : `伺服器錯誤（${res.status}）`);
  }
  return data as T;
}

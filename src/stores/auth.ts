/**
 * 認證狀態（Zustand）。
 * status：
 *  - loading     啟動檢查中
 *  - authed      已登入（伺服器確認）
 *  - offline     伺服器連不上，但此裝置曾登入過 → 允許以離線模式使用本機資料
 *  - anon        未登入 → 導向 /login
 *  - unreachable 伺服器連不上且此裝置沒有登入紀錄
 * 只在 localStorage 保存「上次登入者的 id／名稱／角色」以支援離線開啟，不保存任何權杖或記帳資料。
 */
import { create } from 'zustand';
import { api, ApiError, setUnauthorizedHandler } from '@/services/api';

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: 'user' | 'admin';
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
}

type Status = 'loading' | 'authed' | 'offline' | 'anon' | 'unreachable';
const SESSION_KEY = 'clure.session';

/** 是否啟用帳號系統（建置時 VITE_AUTH_MODE=off 可關閉，回到純本機模式） */
export const AUTH_ENABLED = import.meta.env.VITE_AUTH_MODE !== 'off';

function saveSession(u: AuthUser | null) {
  try {
    if (u) localStorage.setItem(SESSION_KEY, JSON.stringify({ id: u.id, username: u.username, email: u.email, role: u.role }));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* 私密瀏覽等情況忽略 */ }
}

function cachedSession(): AuthUser | null {
  try {
    const v = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    return v && typeof v.id === 'number' ? { must_change_password: false, created_at: '', last_login_at: null, ...v } : null;
  } catch { return null; }
}

interface AuthState {
  status: Status;
  user: AuthUser | null;
  init: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<AuthUser>;
  register: (username: string, email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
}

// 這台裝置曾登入過就先當作已登入，直接開啟本機資料庫；/auth/me 在背景確認，過期再導向登入頁。
// 這樣直接輸入網址或重新整理時不會先卡在載入畫面等伺服器回應。
const initialCached = AUTH_ENABLED ? cachedSession() : null;

export const useAuth = create<AuthState>((set, get) => ({
  status: initialCached ? 'authed' : 'loading',
  user: initialCached,

  init: async () => {
    try {
      const user = await api<AuthUser>('/auth/me');
      const prev = cachedSession();
      saveSession(user);
      if (prev && prev.id !== user.id) { location.replace('/'); return; } // Cookie 屬於另一位使用者：重新載入以切換資料庫
      set({ status: 'authed', user });
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        const cached = cachedSession();
        set(cached ? { status: 'offline', user: cached } : { status: 'unreachable', user: null });
      } else if (e instanceof ApiError && (e.status === 502 || e.status === 503 || e.status === 504)) {
        const cached = cachedSession();
        set(cached ? { status: 'offline', user: cached } : { status: 'unreachable', user: null });
      } else {
        set({ status: 'anon', user: null });
      }
    }
  },

  login: async (identifier, password) => {
    const user = await api<AuthUser>('/auth/login', { method: 'POST', body: { identifier, password } });
    const prev = cachedSession();
    saveSession(user);
    // 換人登入：重新載入以確保切換到新使用者的資料庫與設定
    if (prev && prev.id !== user.id && get().status !== 'anon') location.replace('/');
    set({ status: 'authed', user });
    return user;
  },

  register: async (username, email, password) => {
    const user = await api<AuthUser>('/auth/register', { method: 'POST', body: { username, email, password } });
    saveSession(user);
    set({ status: 'authed', user });
    return user;
  },

  logout: async () => {
    // 登出前先把尚未上傳的帳目送出
    await import('@/services/sync').then((m) => m.flushBeforeLogout()).catch(() => undefined);
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    saveSession(null);
    // 重新載入，清除記憶體中的資料與設定
    location.replace('/login');
  },

  changePassword: async (current, next) => {
    const user = await api<AuthUser>('/auth/change-password', { method: 'POST', body: { current_password: current, new_password: next } });
    saveSession(user);
    set({ user });
  },
}));

// 任何 API 在刷新權杖後仍為 401：視為登出
setUnauthorizedHandler(() => {
  const s = useAuth.getState();
  if (s.status === 'authed') {
    saveSession(null);
    location.replace('/login?expired=1');
  }
});

// 恢復連線時重新驗證離線模式的身分
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (useAuth.getState().status === 'offline') void useAuth.getState().init();
  });
}

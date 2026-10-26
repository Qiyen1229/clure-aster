/**
 * 認證閘道：App 啟動時檢查登入狀態。
 *  - 未登入 → 只能看到 /login、/register
 *  - 已登入（或離線但曾登入）→ 切換到該使用者的 IndexedDB、載入設定 → 進入 App
 *  - 首次登入且裝置上有「帳號系統啟用前」的資料 → 詢問是否歸屬到此帳號
 *  - 管理員重設密碼後 → 強制先變更密碼
 *  - 進入 App 前先與伺服器同步一次（新裝置登入即取得其他裝置的帳目與設定），之後背景持續同步
 *  - 帳號已啟用端對端加密、這台裝置還沒有金鑰 → 先輸入加密密碼（否則拿不到資料，會誤進首次設定）
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import App from '../App';
import { adoptLegacyData, discardLegacyData, legacyDataCount, openUserDatabase } from '@/db/schema';
import { bootstrap } from '@/db/bootstrap';
import { useSettings } from '@/stores/settings';
import { AUTH_ENABLED, useAuth } from '@/stores/auth';
import { useLock } from '@/services/lock';
import { initialSync, startSync, unlockEncryption, useSync } from '@/services/sync';

const LoginPage = lazy(() => import('../features/auth/AuthPages').then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('../features/auth/AuthPages').then((m) => ({ default: m.RegisterPage })));
const ForceChangePasswordPage = lazy(() => import('../features/auth/AuthPages').then((m) => ({ default: m.ForceChangePasswordPage })));

function Splash({ text }: { text?: string }) {
  return (
    <div id="boot" aria-busy="true" aria-label={text ?? '載入中'}>
      <img src="/icons/icon-192.png" alt="" />
      {text && <p className="boot-text">{text}</p>}
    </div>
  );
}

type DataState = { phase: 'idle' | 'loading' | 'syncing' | 'adopt' | 'unlock' | 'ready' | 'error'; legacy?: number; error?: string };

/** 新裝置：輸入端對端加密密碼後才下載資料 */
function UnlockEncryption({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const logout = useAuth((s) => s.logout);
  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr('');
        try {
          if (await unlockEncryption(pw)) onDone();
          else setErr('加密密碼不正確');
        } catch (ex) { setErr((ex as Error).message); } finally { setBusy(false); }
      }}>
        <div style={{ fontSize: 44 }}>🔐</div>
        <h1>輸入加密密碼</h1>
        <p className="muted">這個帳號已啟用端對端加密。請輸入在其他裝置設定的「加密密碼」（不是登入密碼），才能取得你的帳目。</p>
        <label className="sr-only" htmlFor="unlock-pw">加密密碼</label>
        <input id="unlock-pw" className="input" type="password" autoComplete="off" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="加密密碼" />
        {err && <p role="alert" style={{ color: 'var(--danger)', margin: '8px 0 0' }}>{err}</p>}
        <button className="btn" type="submit" style={{ marginTop: 12 }} disabled={busy || !pw}>{busy ? '解密中…' : '解鎖並同步'}</button>
        <button className="btn secondary" type="button" style={{ marginTop: 8 }} onClick={() => void logout()}>登出</button>
      </form>
    </main>
  );
}

export default function AuthGate() {
  const { status, user, init } = useAuth();
  const location = useLocation();
  const [data, setData] = useState<DataState>({ phase: 'idle' });

  useEffect(() => {
    if (AUTH_ENABLED) void init();
  }, [init]);

  const signedIn = !AUTH_ENABLED || status === 'authed' || status === 'offline';
  const userId = AUTH_ENABLED ? user?.id : 'local';

  // 登入後準備資料庫
  useEffect(() => {
    if (!signedIn || userId === undefined || data.phase !== 'idle') return;
    setData({ phase: 'loading' });
    (async () => {
      try {
        if (AUTH_ENABLED) {
          await openUserDatabase(userId!);
          const legacy = await legacyDataCount();
          if (legacy > 0) { setData({ phase: 'adopt', legacy }); return; }
        }
        if ((await finishBootstrap(() => setData({ phase: 'syncing' }))) === 'locked') { setData({ phase: 'unlock' }); return; }
        setData({ phase: 'ready' });
      } catch (e) {
        setData({ phase: 'error', error: (e as Error).message });
      }
    })();
  }, [signedIn, userId, data.phase]);

  if (AUTH_ENABLED && status === 'loading') return <Splash />;

  if (AUTH_ENABLED && status === 'unreachable') {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <h1>無法連線到伺服器</h1>
          <p className="muted">第一次使用需要連線登入。請確認網路或伺服器是否正常，再重試一次。</p>
          <button className="btn" onClick={() => void init()}>重試</button>
        </div>
      </main>
    );
  }

  if (AUTH_ENABLED && status === 'anon') {
    return (
      <Suspense fallback={<Splash />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname + location.search }} />} />
        </Routes>
      </Suspense>
    );
  }

  if (data.phase === 'error') {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <h1>無法開啟資料庫</h1>
          <p className="muted">{data.error}</p>
          <p className="muted">請確認未使用「私密瀏覽」，並檢查裝置儲存空間。</p>
          <button className="btn" onClick={() => window.location.reload()}>重新整理</button>
        </div>
      </main>
    );
  }

  if (data.phase === 'adopt') {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div style={{ fontSize: 44 }}>📦</div>
          <h1>發現這台裝置上的記帳資料</h1>
          <p className="muted">在啟用帳號之前，這台裝置已有約 {data.legacy} 筆資料。要把它們歸到「{user?.username}」帳號嗎？</p>
          <button className="btn" onClick={async () => {
            setData({ phase: 'loading' });
            await adoptLegacyData();
            setData({ phase: (await finishBootstrap(() => setData({ phase: 'syncing' }))) === 'locked' ? 'unlock' : 'ready' });
          }}>歸到我的帳號</button>
          <button className="btn secondary" style={{ marginTop: 10 }} onClick={async () => {
            if (!window.confirm('確定刪除這些舊資料？此動作無法復原。')) return;
            setData({ phase: 'loading' });
            await discardLegacyData();
            setData({ phase: (await finishBootstrap(() => setData({ phase: 'syncing' }))) === 'locked' ? 'unlock' : 'ready' });
          }}>不要，刪除舊資料</button>
        </div>
      </main>
    );
  }

  if (data.phase === 'unlock') {
    return <UnlockEncryption onDone={() => {
      setData({ phase: 'loading' });
      void finishBootstrap().then(() => setData({ phase: 'ready' }), (e) => setData({ phase: 'error', error: (e as Error).message }));
    }} />;
  }
  if (data.phase === 'syncing') return <Splash text="正在同步你的帳目…" />;
  if (data.phase !== 'ready') return <Splash />;

  if (AUTH_ENABLED && status === 'authed' && user?.must_change_password) {
    return <Suspense fallback={<Splash />}><ForceChangePasswordPage /></Suspense>;
  }

  // 已登入時造訪 /login、/register → 回首頁
  if (location.pathname === '/login' || location.pathname === '/register') return <Navigate to="/" replace />;
  return <App />;
}

/** 回傳 'locked'：需要先輸入端對端加密密碼（此時尚未建立預設資料） */
async function finishBootstrap(onSyncing?: () => void): Promise<'ok' | 'locked'> {
  if (AUTH_ENABLED) {
    // 先下載其他裝置的資料再建立預設值；離線或逾時則先用本機資料，背景繼續同步
    onSyncing?.();
    await initialSync().catch(() => undefined);
    if (useSync.getState().phase === 'locked') return 'locked';
  }
  const settings = await bootstrap();
  useSettings.getState().hydrate(settings);
  if (settings.lock.enabled && settings.lock.pinHash) useLock.setState({ locked: true });
  if (AUTH_ENABLED) startSync();
  return 'ok';
}

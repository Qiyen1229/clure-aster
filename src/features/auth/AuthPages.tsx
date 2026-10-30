/**
 * 登入／註冊／變更密碼頁面。
 * 密碼只在送出時傳給伺服器，前端不保存；權杖由伺服器設定為 HttpOnly Cookie。
 */
import { ICON_192 } from '@/ui/assets';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { Icon } from '@/ui/Icon';

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <img src={ICON_192} alt="" width={64} height={64} className="auth-logo" />
        <h1>{title}</h1>
        {subtitle && <p className="muted" style={{ margin: '0 0 20px' }}>{subtitle}</p>}
        {children}
      </div>
      {footer && <div className="auth-footer">{footer}</div>}
      <p className="disclaimer">🔒 帳號與帳目都存放在你自己架設的伺服器，登入任何裝置都能看到同一份資料。</p>
    </main>
  );
}

/** 管理員是否開放註冊；查不到（離線、舊版伺服器）時當作開放，由伺服器在送出時把關 */
function useRegistrationOpen(): boolean | null {
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => { void api<{ open: boolean }>('/auth/registration').then((r) => setOpen(r.open), () => setOpen(true)); }, []);
  return open;
}

function PasswordInput({ id, value, onChange, autoComplete, placeholder }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input id={id} className="input" type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete} placeholder={placeholder} required maxLength={128} style={{ paddingRight: 48 }} />
      <button type="button" className="icon-btn plain" aria-label={show ? '隱藏密碼' : '顯示密碼'} onClick={() => setShow((x) => !x)}
        style={{ position: 'absolute', right: 2, top: 1 }}>
        <Icon name={show ? 'eyeOff' : 'eye'} size={20} />
      </button>
    </div>
  );
}

export function passwordIssues(pw: string, username = ''): string[] {
  const out: string[] = [];
  if (pw.length < 8) out.push('至少 8 個字元');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) out.push('需包含英文字母與數字');
  if (username && pw.toLowerCase() === username.toLowerCase()) out.push('不可與使用者名稱相同');
  return out;
}

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : '發生錯誤，請稍後再試';
}

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const registrationOpen = useRegistrationOpen();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(params.get('expired') ? '登入已過期，請重新登入' : '');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(identifier.trim(), password);
      const next = (location.state as { from?: string } | null)?.from;
      navigate(next && next.startsWith('/') && !next.startsWith('/login') ? next : '/', { replace: true });
    } catch (err) {
      setError(errorText(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="登入 Aster" subtitle="歡迎回來" footer={registrationOpen ? <>還沒有帳號？<Link to="/register" className="accent">註冊</Link></> : undefined}>
      <form onSubmit={submit} className="auth-form" noValidate>
        <label htmlFor="login-id">使用者名稱或 Email</label>
        <input id="login-id" className="input" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={254} autoFocus />
        <label htmlFor="login-pw">密碼</label>
        <PasswordInput id="login-pw" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="btn" type="submit" disabled={busy || !identifier || !password}>{busy ? '登入中…' : '登入'}</button>
        <Link to="/forgot-password" className="accent" style={{ textAlign: 'center', fontSize: '0.9rem' }}>忘記密碼？</Link>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const registrationOpen = useRegistrationOpen();
  const register = useAuth((s) => s.register);
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const issues = passwordIssues(password, username);
  const userOk = /^[A-Za-z0-9_.-]{3,32}$/.test(username);
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!userOk) return setError('使用者名稱只能使用英文、數字、底線、點與連字號（3–32 字元）');
    if (!emailOk) return setError('Email 格式不正確');
    if (issues.length) return setError(`密碼${issues.join('、')}`);
    if (password !== confirm) return setError('兩次輸入的密碼不一致');
    setBusy(true);
    setError('');
    try {
      await register(username.trim(), email.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (registrationOpen === false) {
    return (
      <AuthShell title="目前未開放註冊" subtitle="請向管理員索取帳號" footer={<>已經有帳號？<Link to="/login" className="accent">登入</Link></>}>
        <p className="muted" style={{ margin: 0 }}>這台伺服器只給特定成員使用。需要帳號時，請聯絡架設的人幫你建立。</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="建立帳號" subtitle="註冊後即可在這台裝置開始記帳" footer={<>已經有帳號？<Link to="/login" className="accent">登入</Link></>}>
      <form onSubmit={submit} className="auth-form" noValidate>
        <label htmlFor="reg-user">使用者名稱</label>
        <input id="reg-user" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={32} required autoFocus placeholder="英數、底線、點、連字號" />
        <label htmlFor="reg-email">Email</label>
        <input id="reg-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required />
        <label htmlFor="reg-pw">密碼</label>
        <PasswordInput id="reg-pw" value={password} onChange={setPassword} autoComplete="new-password" placeholder="至少 8 字元，含英文與數字" />
        {password && (
          <ul className="pw-rules" aria-live="polite">
            {['至少 8 個字元', '需包含英文字母與數字'].map((r) => <li key={r} className={issues.includes(r) ? '' : 'ok'}>{issues.includes(r) ? '○' : '✓'} {r}</li>)}
          </ul>
        )}
        <label htmlFor="reg-pw2">確認密碼</label>
        <PasswordInput id="reg-pw2" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="btn" type="submit" disabled={busy}>{busy ? '建立中…' : '註冊'}</button>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [info, setInfo] = useState<{ mail: boolean; contact: string } | null>(null);
  useEffect(() => { void api<{ mail: boolean; contact: string }>('/auth/forgot-info').then(setInfo, () => setInfo({ mail: false, contact: '' })); }, []);
  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ message: string }>('/auth/forgot-password', { method: 'POST', body: { identifier: identifier.trim() } });
      setDone(r.message);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  // 伺服器沒設定寄信：請使用者寄信給管理員，由管理員在後台重設（會產生臨時密碼）
  if (info && !info.mail) {
    const subject = encodeURIComponent('Aster 記帳：申請重設密碼');
    const body = encodeURIComponent(`管理員你好，我忘記 Aster 記帳的密碼，請幫我重設。\n我的使用者名稱／Email：${identifier.trim() || '（請填寫）'}\n`);
    return (
      <AuthShell title="忘記密碼" subtitle="請聯絡管理員幫你重設" footer={<Link to="/login" className="accent">回到登入</Link>}>
        <div className="auth-form">
          <label htmlFor="fp-id">你的使用者名稱或 Email（會帶進信件內容）</label>
          <input id="fp-id" className="input" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={254} />
          {info.contact ? (
            <a className="btn" href={`mailto:${info.contact}?subject=${subject}&body=${body}`}>寄信給管理員（{info.contact}）</a>
          ) : <p className="muted" style={{ margin: 0 }}>請直接聯絡架設這個網站的人。</p>}
          <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>管理員會給你一組臨時密碼，登入後必須立刻設定新密碼。為了安全，請不要在信裡寫出你的密碼。</p>
        </div>
      </AuthShell>
    );
  }
  if (!info) return <AuthShell title="忘記密碼"><p className="muted" style={{ margin: 0 }}>載入中…</p></AuthShell>;
  return (
    <AuthShell title="忘記密碼" subtitle="輸入註冊時的 Email 或使用者名稱，我們會寄重設連結給你" footer={<Link to="/login" className="accent">回到登入</Link>}>
      {done ? (
        <p role="status" style={{ margin: 0 }}>✉️ {done}<br /><span className="muted" style={{ fontSize: '0.85rem' }}>連結 30 分鐘內有效，只能使用一次。</span></p>
      ) : (
        <form onSubmit={submit} className="auth-form" noValidate>
          <label htmlFor="fp-id">Email 或使用者名稱</label>
          <input id="fp-id" className="input" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username"
            autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={254} autoFocus />
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="btn" type="submit" disabled={busy || identifier.trim().length < 3}>{busy ? '寄送中…' : '寄送重設連結'}</button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const issues = passwordIssues(pw);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (issues.length) return setError(`密碼${issues.join('、')}`);
    if (pw !== confirm) return setError('兩次輸入的密碼不一致');
    setBusy(true);
    setError('');
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, new_password: pw } });
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 1800);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  if (!token) {
    return <AuthShell title="連結不完整" footer={<Link to="/forgot-password" className="accent">重新申請</Link>}><p className="muted" style={{ margin: 0 }}>請直接點信中的完整連結。</p></AuthShell>;
  }
  return (
    <AuthShell title="設定新密碼" footer={<Link to="/login" className="accent">回到登入</Link>}>
      {done ? <p role="status" style={{ margin: 0 }}>✓ 密碼已重設，正在前往登入…</p> : (
        <form onSubmit={submit} className="auth-form" noValidate>
          <label htmlFor="rp-pw">新密碼</label>
          <PasswordInput id="rp-pw" value={pw} onChange={setPw} autoComplete="new-password" placeholder="至少 8 字元，含英文與數字" />
          <label htmlFor="rp-pw2">確認新密碼</label>
          <PasswordInput id="rp-pw2" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="btn" type="submit" disabled={busy || !pw}>{busy ? '儲存中…' : '重設密碼'}</button>
        </form>
      )}
    </AuthShell>
  );
}

/** 變更密碼表單（設定頁與「管理員重設後強制變更」共用） */
export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const { user, changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const issues = passwordIssues(next, user?.username);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (issues.length) return setError(`新密碼${issues.join('、')}`);
    if (next !== confirm) return setError('兩次輸入的新密碼不一致');
    setBusy(true);
    setError('');
    try {
      await changePassword(current, next);
      onDone?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="auth-form" noValidate>
      <input type="text" autoComplete="username" value={user?.username ?? ''} readOnly hidden />
      <label htmlFor="cp-cur">目前密碼</label>
      <PasswordInput id="cp-cur" value={current} onChange={setCurrent} autoComplete="current-password" />
      <label htmlFor="cp-new">新密碼</label>
      <PasswordInput id="cp-new" value={next} onChange={setNext} autoComplete="new-password" placeholder="至少 8 字元，含英文與數字" />
      <label htmlFor="cp-new2">確認新密碼</label>
      <PasswordInput id="cp-new2" value={confirm} onChange={setConfirm} autoComplete="new-password" />
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="btn" type="submit" disabled={busy || !current || !next}>{busy ? '變更中…' : '變更密碼'}</button>
      <p className="muted" style={{ fontSize: '0.8rem', margin: 0 }}>變更後，其他裝置上的登入會被登出。</p>
    </form>
  );
}

export function ForceChangePasswordPage() {
  const logout = useAuth((s) => s.logout);
  return (
    <AuthShell title="請設定新密碼" subtitle="管理員已重設你的密碼，請先設定一組新密碼再繼續使用"
      footer={<button className="accent" onClick={() => void logout()}>登出</button>}>
      <ChangePasswordForm />
    </AuthShell>
  );
}

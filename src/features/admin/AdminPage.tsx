/**
 * 管理員資安後台（/admin/*）：系統總覽、使用者管理、資安審計日誌。
 * 前端路由守衛僅為使用體驗；真正的權限檢查在後端 require_admin。
 */
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { useUI } from '@/stores/ui';
import { EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

interface Stats {
  total_users: number; active_users: number; frozen_users: number; admins: number; active_today: number;
  new_users_today: number; failed_logins_today: number; locked_accounts: number; db_size_bytes: number; db_engine: string; warnings?: string[];
}
interface AdminUser {
  id: number; username: string; email: string; role: 'user' | 'admin'; is_active: boolean; created_at: string;
  last_login_at: string | null; last_seen_at: string | null; failed_login_count: number; locked_until: string | null; must_change_password: boolean;
}
interface AuditLog {
  id: number; created_at: string; user_id: number | null; username: string | null; actor_id: number | null; actor_username: string | null;
  action: string; success: boolean; ip: string; user_agent: string; detail: Record<string, unknown> | null;
}
interface Page<T> { items: T[]; total: number; page: number; size: number }

export const ACTION_LABEL: Record<string, string> = {
  'auth.register': '註冊', 'auth.login': '登入', 'auth.login_locked': '鎖定中嘗試登入', 'auth.logout': '登出',
  'auth.refresh_reuse': '權杖重用（疑似遭竊）', 'auth.password_change': '變更密碼',
  'admin.user_list_view': '查看使用者列表', 'admin.audit_view': '查看審計日誌', 'admin.stats_view': '查看系統統計',
  'admin.cli_create_admin': '建立管理員（指令列）', 'admin.cli_delete_user': '刪除使用者（指令列）',
  'sync.e2ee_on': '啟用端對端加密', 'sync.e2ee_off': '停用端對端加密', 'push.subscribe': '啟用背景推播',
  'admin.user_freeze': '凍結帳號', 'admin.user_unfreeze': '啟用帳號', 'admin.force_logout': '強制登出', 'admin.password_reset': '重設密碼',
};

/** 伺服器回傳 UTC（無時區）→ 本地時間字串 */
export function fmtTime(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s.endsWith('Z') || s.includes('+') ? s : `${s}Z`);
  return d.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function shortUA(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua.slice(0, 24);
  return [os, br].filter(Boolean).join(' · ') || '未知';
}

function useApi<T>(path: string, query?: Record<string, string | number | boolean | undefined | null>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const key = JSON.stringify(query ?? {});
  const load = useCallback(async () => {
    setError('');
    try { setData(await api<T>(path, { query })); }
    catch (e) { setError(e instanceof ApiError ? e.message : '載入失敗'); }
  }, [path, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  return { data, error, reload: load, setData };
}

export default function AdminPage() {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  if (user?.role !== 'admin') {
    return <main className="page"><EmptyState emoji="⛔️" title="需要管理員權限" text="只有系統管理員可以進入資安後台。" action={<button className="btn small" onClick={() => navigate('/')}>回首頁</button>} /></main>;
  }
  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回設定" onClick={() => navigate('/settings')}><Icon name="chevronL" /></button>
        <h1>資安後台</h1>
        <div style={{ width: 44 }} />
      </header>
      <nav className="admin-tabs" aria-label="後台功能">
        <NavLink to="/admin" end>總覽</NavLink>
        <NavLink to="/admin/users">使用者</NavLink>
        <NavLink to="/admin/audit">審計日誌</NavLink>
      </nav>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="users" element={<Users />} />
        <Route path="audit" element={<Audit />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </main>
  );
}

function Overview() {
  const { data, error, reload } = useApi<Stats>('/admin/stats');
  const recent = useApi<Page<AuditLog>>('/admin/audit-logs', { success: false, size: 5 });
  const navigate = useNavigate();
  if (error) return <EmptyState emoji="⚠️" title="無法載入統計" text={error} action={<button className="btn small" onClick={() => void reload()}>重試</button>} />;
  if (!data) return <SkeletonRows n={3} />;
  const cards: { k: string; v: string | number; warn?: boolean; to?: string }[] = [
    { k: '總註冊用戶', v: data.total_users, to: '/admin/users' },
    { k: '今日活躍', v: data.active_today },
    { k: '今日新註冊', v: data.new_users_today },
    { k: '今日登入失敗', v: data.failed_logins_today, warn: data.failed_logins_today > 0, to: '/admin/audit?failed=1' },
    { k: '鎖定中帳號', v: data.locked_accounts, warn: data.locked_accounts > 0 },
    { k: '已凍結帳號', v: data.frozen_users },
    { k: '管理員', v: data.admins },
    { k: `資料庫（${data.db_engine}）`, v: fmtBytes(data.db_size_bytes) },
  ];
  return (
    <>
      {!!data.warnings?.length && (
        <div className="card admin-warnings" role="alert">
          <div className="row-title">⚠️ 部署設定提醒</div>
          <ul>{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          <p className="muted">修改 NAS 上的 .env 後執行 docker compose up -d 套用。</p>
        </div>
      )}
      <div className="admin-grid">
        {cards.map((c) => (
          <button key={c.k} className={`admin-stat${c.warn ? ' warn' : ''}`} onClick={() => c.to && navigate(c.to)} disabled={!c.to}>
            <div className="k">{c.k}</div>
            <div className="v num">{c.v}</div>
          </button>
        ))}
      </div>
      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>最近的失敗事件</span>
        <button className="accent" onClick={() => { void reload(); void recent.reload(); }}>重新整理</button>
      </div>
      {!recent.data ? <SkeletonRows n={2} /> : recent.data.items.length === 0 ? <p className="muted" style={{ margin: '0 8px' }}>沒有失敗事件 ✓</p> : (
        <div className="list">{recent.data.items.map((l) => <AuditRow key={l.id} log={l} />)}</div>
      )}
    </>
  );
}

function Users() {
  const me = useAuth((s) => s.user);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'frozen' | 'locked'>('all');
  const [page, setPage] = useState(1);
  const { data, error, reload } = useApi<Page<AdminUser>>('/admin/users', { q: query, status, page, size: 20 });
  const [sel, setSel] = useState<AdminUser | null>(null);
  const [temp, setTemp] = useState<{ user: string; pw: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const snack = (text: string) => useUI.getState().showSnack({ text });

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); snack(ok); await reload(); setSel(null); }
    catch (e) { snack(e instanceof ApiError ? e.message : '操作失敗'); }
    finally { setBusy(false); }
  };
  const locked = (u: AdminUser) => !!u.locked_until && new Date(`${u.locked_until}Z`) > new Date();

  return (
    <>
      <form onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q.trim()); }} style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input className="input" type="search" placeholder="搜尋帳號或 Email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜尋使用者" />
        <button className="btn small" type="submit">搜尋</button>
      </form>
      <Segmented value={status} onChange={(v) => { setStatus(v); setPage(1); }} ariaLabel="狀態篩選"
        options={[{ value: 'all', label: '全部' }, { value: 'active', label: '正常' }, { value: 'frozen', label: '凍結' }, { value: 'locked', label: '鎖定' }]} />
      {error ? <EmptyState emoji="⚠️" title="無法載入" text={error} /> : !data ? <SkeletonRows /> : data.items.length === 0 ? <EmptyState emoji="🫥" title="沒有符合的使用者" /> : (
        <>
          <p className="muted" style={{ fontSize: '0.8rem', margin: '10px 4px' }}>共 {data.total} 位</p>
          <div className="list">
            {data.items.map((u) => (
              <button key={u.id} className="row" onClick={() => setSel(u)}>
                <span className="cat-icon sm" aria-hidden="true">{u.username.slice(0, 1).toUpperCase()}</span>
                <div className="row-main">
                  <div className="row-title">
                    {u.username} <span className="muted num" style={{ fontSize: '0.75rem' }}>#{u.id}</span>
                    {u.role === 'admin' && <span className="chip" style={{ marginLeft: 6 }}>管理員</span>}
                  </div>
                  <div className="row-sub">{u.email} · 最後登入 {fmtTime(u.last_login_at)}</div>
                </div>
                <span className="chip" style={{ ['--c' as string]: !u.is_active ? 'var(--danger)' : locked(u) ? 'var(--warning)' : 'var(--success)' }}>
                  {!u.is_active ? '凍結' : locked(u) ? '鎖定' : '正常'}
                </span>
              </button>
            ))}
          </div>
          <div className="btn-row" style={{ justifyContent: 'center', marginTop: 8 }}>
            <button className="btn small secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一頁</button>
            <span className="muted num" style={{ alignSelf: 'center' }}>{page} / {Math.max(1, Math.ceil(data.total / data.size))}</span>
            <button className="btn small secondary" disabled={page * data.size >= data.total} onClick={() => setPage(page + 1)}>下一頁</button>
          </div>
        </>
      )}

      <Sheet open={!!sel} onClose={() => setSel(null)} title={sel?.username}>
        {sel && (
          <>
            <div className="list">
              {[
                ['ID', `#${sel.id}`], ['Email', sel.email], ['角色', sel.role === 'admin' ? '管理員' : '一般使用者'],
                ['狀態', !sel.is_active ? '已凍結' : locked(sel) ? `鎖定至 ${fmtTime(sel.locked_until)}` : '正常'],
                ['註冊時間', fmtTime(sel.created_at)], ['最後登入', fmtTime(sel.last_login_at)], ['最後活動', fmtTime(sel.last_seen_at)],
                ['連續登入失敗', String(sel.failed_login_count)], ['需變更密碼', sel.must_change_password ? '是' : '否'],
              ].map(([k, v]) => <div key={k} className="row"><span className="muted" style={{ width: 96 }}>{k}</span><span className="row-main" style={{ wordBreak: 'break-all' }}>{v}</span></div>)}
            </div>
            {sel.id === me?.id && <p className="muted" style={{ fontSize: '0.8rem' }}>這是你自己的帳號，無法凍結。</p>}
            <div style={{ display: 'grid', gap: 10 }}>
              {sel.is_active ? (
                <button className="btn danger" disabled={busy || sel.id === me?.id} onClick={() => {
                  const reason = window.prompt(`凍結「${sel.username}」？對方會立即被登出且無法登入。\n原因（選填）：`, '');
                  if (reason === null) return;
                  void act(() => api(`/admin/users/${sel.id}/status`, { method: 'PATCH', body: { is_active: false, reason } }), '已凍結帳號');
                }}>凍結帳號</button>
              ) : (
                <button className="btn" disabled={busy} onClick={() => void act(() => api(`/admin/users/${sel.id}/status`, { method: 'PATCH', body: { is_active: true } }), '已啟用帳號')}>啟用帳號</button>
              )}
              {locked(sel) && sel.is_active && (
                <button className="btn tinted" disabled={busy} onClick={() => void act(() => api(`/admin/users/${sel.id}/status`, { method: 'PATCH', body: { is_active: true } }), '已解除鎖定')}>解除登入鎖定</button>
              )}
              <button className="btn tinted" disabled={busy} onClick={() => {
                if (!window.confirm(`強制登出「${sel.username}」的所有裝置？`)) return;
                void act(() => api(`/admin/users/${sel.id}/force-logout`, { method: 'POST' }), '已強制登出');
              }}>強制登出所有裝置</button>
              <button className="btn secondary" disabled={busy} onClick={async () => {
                if (!window.confirm(`重設「${sel.username}」的密碼？會產生一組臨時密碼，對方下次登入時必須變更。`)) return;
                setBusy(true);
                try {
                  const r = await api<{ temporary_password: string }>(`/admin/users/${sel.id}/reset-password`, { method: 'POST' });
                  setTemp({ user: sel.username, pw: r.temporary_password });
                  setSel(null);
                  await reload();
                } catch (e) { snack(e instanceof ApiError ? e.message : '重設失敗'); }
                finally { setBusy(false); }
              }}>重設密碼</button>
            </div>
          </>
        )}
      </Sheet>

      <Sheet open={!!temp} onClose={() => setTemp(null)} title="臨時密碼">
        {temp && (
          <>
            <p>請透過安全管道把這組臨時密碼交給 <b>{temp.user}</b>。<br /><span className="danger">關閉後將無法再次查看。</span></p>
            <div className="temp-pw num" aria-label="臨時密碼">{temp.pw}</div>
            <button className="btn" onClick={async () => {
              try { await navigator.clipboard.writeText(temp.pw); snack('已複製'); } catch { snack('無法複製，請手動抄寫'); }
            }}>複製</button>
          </>
        )}
      </Sheet>
    </>
  );
}

function AuditRow({ log }: { log: AuditLog }) {
  const [open, setOpen] = useState(false);
  return (
    <button className="row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 2 }} onClick={() => setOpen((x) => !x)} aria-expanded={open}>
      <div style={{ display: 'flex', width: '100%', gap: 8, alignItems: 'center' }}>
        <span className="chip" style={{ ['--c' as string]: log.success ? 'var(--success)' : 'var(--danger)' }}>{log.success ? '成功' : '失敗'}</span>
        <b className="row-main" style={{ fontSize: '0.92rem' }}>{ACTION_LABEL[log.action] ?? log.action}</b>
        <span className="muted num" style={{ fontSize: '0.75rem' }}>{fmtTime(log.created_at)}</span>
      </div>
      <div className="row-sub" style={{ whiteSpace: 'normal' }}>
        {[
          log.username ? `帳號 ${log.username}` : log.user_id ? `帳號 #${log.user_id}` : log.actor_id ? null : '帳號不存在',
          log.actor_username ? `操作者 ${log.actor_username}` : null,
          log.ip,
          shortUA(log.user_agent),
        ].filter(Boolean).join(' · ')}
      </div>
      {open && (
        <div className="row-sub" style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>
          User-Agent：{log.user_agent || '—'}{log.detail ? <><br />詳細：{JSON.stringify(log.detail)}</> : null}
        </div>
      )}
    </button>
  );
}

function Audit() {
  const failedOnly = new URLSearchParams(location.search).get('failed') === '1';
  const [action, setAction] = useState('');
  const [result, setResult] = useState<'all' | 'ok' | 'fail'>(failedOnly ? 'fail' : 'all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AuditLog[]>([]);
  const query = { action: action || undefined, success: result === 'all' ? undefined : result === 'ok', date_from: from || undefined, date_to: to || undefined, page, size: 50 };
  const { data, error } = useApi<Page<AuditLog>>('/admin/audit-logs', query);
  useEffect(() => { if (data) setItems((prev) => (data.page === 1 ? data.items : [...prev, ...data.items])); }, [data]);
  const reset = () => { setPage(1); setItems([]); };

  return (
    <>
      <div className="list">
        <div className="field"><span className="label">動作</span>
          <select value={action} onChange={(e) => { setAction(e.target.value); reset(); }}>
            <option value="">全部</option>
            <option value="auth.">認證（全部）</option>
            <option value="admin.">管理操作（全部）</option>
            {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="field"><span className="label">結果</span>
          <select value={result} onChange={(e) => { setResult(e.target.value as 'all' | 'ok' | 'fail'); reset(); }}>
            <option value="all">全部</option><option value="ok">成功</option><option value="fail">失敗</option>
          </select>
        </div>
        <div className="field"><span className="label">開始日期</span><input type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); reset(); }} /></div>
        <div className="field"><span className="label">結束日期</span><input type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); reset(); }} /></div>
      </div>
      {error ? <EmptyState emoji="⚠️" title="無法載入" text={error} /> : !data && !items.length ? <SkeletonRows /> : items.length === 0 ? <EmptyState emoji="📜" title="沒有符合的紀錄" /> : (
        <>
          <p className="muted" style={{ fontSize: '0.8rem', margin: '0 4px 8px' }}>共 {data?.total ?? items.length} 筆（點擊看完整 User-Agent 與詳細）</p>
          <div className="list">{items.map((l) => <AuditRow key={l.id} log={l} />)}</div>
          {data && items.length < data.total && <button className="btn secondary" onClick={() => setPage(page + 1)}>載入更多</button>}
        </>
      )}
    </>
  );
}

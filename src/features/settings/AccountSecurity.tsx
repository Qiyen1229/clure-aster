/**
 * 帳號安全（設定 → 隱私與安全）：
 * - 雙因素驗證（TOTP）：Google Authenticator、iPhone「密碼」App、1Password 等都能用；新裝置登入除了密碼還要 6 位數驗證碼
 * - 已登入的裝置：看到每一台登入中的裝置，可以單獨「登出此裝置」（對方的登入立刻失效）
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/services/api';
import { useUI, ask } from '@/stores/ui';
import { deviceFromUA } from '@/services/devices';
import { Sheet } from '@/ui/Sheet';

const snack = (text: string, duration?: number) => useUI.getState().showSnack({ text, duration });
const errText = (e: unknown) => (e instanceof ApiError ? e.message : '發生錯誤，請稍後再試');
async function copy(text: string, label: string) {
  try { await navigator.clipboard.writeText(text); snack(`已複製${label}`); } catch { snack('無法複製，請長按文字自行選取'); }
}

// ───────────── 雙因素驗證 ─────────────

interface TotpStatus { enabled: boolean; recovery_left: number }
type Stage = null | { kind: 'setup'; secret: string; uri: string } | { kind: 'codes'; codes: string[] } | { kind: 'disable' };

export function TwoFactorSection() {
  const [st, setSt] = useState<TotpStatus | null>(null);
  const [stage, setStage] = useState<Stage>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<TotpStatus>('/auth/2fa').then(setSt, () => setSt(null)), []);
  useEffect(() => { void load(); }, [load]);

  const start = async () => {
    setBusy(true);
    try { const r = await api<{ secret: string; uri: string }>('/auth/2fa/setup', { method: 'POST' }); setCode(''); setStage({ kind: 'setup', ...r }); }
    catch (e) { snack(errText(e)); } finally { setBusy(false); }
  };
  const enable = async () => {
    setBusy(true);
    try { const r = await api<{ recovery_codes: string[] }>('/auth/2fa/enable', { method: 'POST', body: { code: code.trim() } }); setStage({ kind: 'codes', codes: r.recovery_codes }); setCode(''); await load(); }
    catch (e) { snack(errText(e), 6000); } finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true);
    try { await api('/auth/2fa/disable', { method: 'POST', body: { password, code: code.trim() } }); setStage(null); setCode(''); setPassword(''); snack('已關閉雙因素驗證'); await load(); }
    catch (e) { snack(errText(e), 6000); } finally { setBusy(false); }
  };
  const group = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

  if (!st) return null;
  return (
    <>
      <div className="section-title">雙因素驗證</div>
      <div className="list">
        {st.enabled ? (
          <>
            <div className="row"><span className="row-main"><span className="row-title">已啟用</span><span className="row-sub" style={{ whiteSpace: 'normal' }}>新裝置登入除了密碼，還要驗證 App 上的 6 位數。剩 {st.recovery_left} 組備援碼</span></span></div>
            <button className="row" style={{ color: 'var(--danger)' }} onClick={() => { setCode(''); setPassword(''); setStage({ kind: 'disable' }); }}>關閉雙因素驗證</button>
          </>
        ) : (
          <>
            <div className="row"><span className="row-main"><span className="row-title">尚未啟用</span><span className="row-sub" style={{ whiteSpace: 'normal' }}>密碼外洩時，沒有手機上的驗證碼就登不進來（網銀等級的保護）</span></span></div>
            <button className="row accent" disabled={busy} onClick={() => void start()}>開始設定</button>
          </>
        )}
      </div>

      <Sheet open={stage?.kind === 'setup'} onClose={() => setStage(null)} title="設定雙因素驗證">
        {stage?.kind === 'setup' && (
          <div className="auth-form" style={{ gap: 10 }}>
            <p className="muted" style={{ margin: 0 }}><b>1.</b> 在手機的驗證 App 新增一組驗證碼。iPhone 可以直接按下面的按鈕，用內建的「密碼」App 加入：</p>
            <a className="btn" href={stage.uri} style={{ textAlign: 'center' }}>在驗證 App／「密碼」App 開啟</a>
            <p className="muted" style={{ margin: 0 }}>沒有跳轉的話，在驗證 App 選「手動輸入」，貼上這組<b>設定密鑰</b>：</p>
            <div className="copy-row"><code style={{ letterSpacing: '0.05em' }}>{group(stage.secret)}</code><button className="pill" onClick={() => void copy(stage.secret, '設定密鑰')}>複製</button></div>
            <p className="muted" style={{ margin: 0 }}><b>2.</b> 輸入 App 上現在顯示的 6 位數，確認設定成功：</p>
            <input className="input num" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} placeholder="6 位數" aria-label="驗證碼" />
            <button className="btn" disabled={busy || code.trim().length < 6} onClick={() => void enable()}>{busy ? '驗證中…' : '啟用'}</button>
            <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>通過驗證才會真的啟用，輸入錯誤不會把你鎖在外面。</p>
          </div>
        )}
      </Sheet>

      <Sheet open={stage?.kind === 'codes'} onClose={() => setStage(null)} title="備援碼">
        {stage?.kind === 'codes' && (
          <div className="auth-form" style={{ gap: 10 }}>
            <p style={{ margin: 0 }}>已啟用。<b>請現在就存好這 8 組備援碼</b>（只會顯示這一次）：手機弄丟、驗證 App 不見時，用其中一組代替驗證碼登入，每組只能用一次。</p>
            <div className="card" style={{ margin: 0, fontFamily: 'ui-monospace, monospace', lineHeight: 1.9, textAlign: 'center' }}>{stage.codes.map((c) => <div key={c}>{c}</div>)}</div>
            <button className="btn tinted" onClick={() => void copy(stage.codes.join('\n'), '備援碼')}>複製全部</button>
            <button className="btn" onClick={() => setStage(null)}>我已存好</button>
          </div>
        )}
      </Sheet>

      <Sheet open={stage?.kind === 'disable'} onClose={() => setStage(null)} title="關閉雙因素驗證">
        {stage?.kind === 'disable' && (
          <div className="auth-form" style={{ gap: 10 }}>
            <p className="muted" style={{ margin: 0 }}>需要密碼和一組驗證碼（或備援碼）。</p>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="密碼" aria-label="密碼" />
            <input className="input num" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" maxLength={20} placeholder="6 位數驗證碼或備援碼" aria-label="驗證碼" />
            <button className="btn" style={{ background: 'var(--danger)' }} disabled={busy || !password || code.trim().length < 6} onClick={() => void disable()}>{busy ? '處理中…' : '關閉'}</button>
          </div>
        )}
      </Sheet>
    </>
  );
}

// ───────────── 已登入的裝置 ─────────────

interface SessionRow { id: string; created_at: string; last_active: string; ip: string; user_agent: string; current: boolean }

const ago = (iso: string) => {
  const t = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? '剛剛' : m < 60 ? `${m} 分鐘前` : m < 1440 ? `${Math.round(m / 60)} 小時前` : `${Math.round(m / 1440)} 天前`;
};

export function SessionsSection() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const load = useCallback(() => api<SessionRow[]>('/auth/sessions').then(setRows, () => setRows(null)), []);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return null;
  return (
    <>
      <div className="section-title">已登入的裝置</div>
      <div className="list">
        {rows.map((r) => (
          <div key={r.id} className="row">
            <span className="row-main">
              <span className="row-title">{deviceFromUA(r.user_agent)}{r.current && <span className="faint">　目前這台</span>}</span>
              <span className="row-sub" style={{ whiteSpace: 'normal' }}>最近使用 {ago(r.last_active)} · 登入於 {new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(r.created_at) ? r.created_at : `${r.created_at}Z`).toLocaleDateString('zh-TW')} · {r.ip || '未知位置'}</span>
            </span>
            {!r.current && (
              <button className="pill" style={{ color: 'var(--danger)' }} onClick={async () => {
                if (!await ask(`登出「${deviceFromUA(r.user_agent)}」？那台裝置的登入會立刻失效，需要重新輸入密碼。`)) return;
                try { await api(`/auth/sessions/${r.id}`, { method: 'DELETE' }); snack('已登出該裝置'); await load(); } catch (e) { snack(errText(e)); }
              }}>登出</button>
            )}
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: '0.8rem', margin: '6px 8px' }}>看到不認得的裝置，先把它登出，再到「帳號與資料管理」修改密碼（改密碼會一併登出其他所有裝置）。</p>
    </>
  );
}

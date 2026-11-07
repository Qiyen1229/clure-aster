/**
 * 鎖定畫面：6 位數 PIN（連錯 5 次需等待 30 秒，之後倍增）＋ Face ID／Touch ID。
 * 錯誤次數與等待時間同時存在 localStorage 與 IndexedDB：重新整理、重開 App、只清其中一邊都不會歸零。
 * 選用：連錯 10 次自動登出並清除這台裝置的本機資料（設定 → 隱私與安全）。
 */
import { ICON_192 } from '@/ui/assets';
import { useEffect, useState } from 'react';
import { useLock, verifyBiometric, verifyPin } from '@/services/lock';
import { readFails, readFailsSync, WIPE_AT, wipeLocalData, writeFails } from '@/services/lockGuard';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';
import { api } from '@/services/api';
import { confirmIdentity } from '@/services/identity';
import { disableLock } from '@/services/lock';
import { AUTH_ENABLED } from '@/stores/auth';
import { ask, useUI } from '@/stores/ui';

export function PinPad({ onComplete, error, disabled }: { onComplete: (pin: string) => void; error?: boolean; disabled?: boolean }) {
  const [pin, setPin] = useState('');
  useEffect(() => { if (error) setPin(''); }, [error]);
  const press = (k: string) => {
    if (disabled) return;
    if (k === '⌫') { setPin((p) => p.slice(0, -1)); return; }
    const next = (pin + k).slice(0, 6);
    setPin(next);
    if (next.length === 6) { setTimeout(() => { onComplete(next); setPin(''); }, 80); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (/^\d$/.test(e.key)) press(e.key); if (e.key === 'Backspace') press('⌫'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="pinpad">
      <div className={`pin-dots${error ? ' shake' : ''}`} aria-label={`已輸入 ${pin.length} 位`}>
        {Array.from({ length: 6 }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
      </div>
      <div className="pin-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) => k === '' ? <span key={i} /> : (
          <button key={i} className="pin-key num" onClick={() => press(k)} aria-label={k === '⌫' ? '刪除' : k} disabled={disabled}>
            {k === '⌫' ? <Icon name="backspace" /> : k}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 第 n 次錯誤後需等待的毫秒數：前 4 次不用等，第 5 次起 30 秒、60 秒、120 秒…最長 1 小時 */
export function lockoutMs(fails: number): number {
  return fails < 5 ? 0 : Math.min(3600_000, 30_000 * 2 ** (fails - 5));
}

export function LockScreen() {
  const locked = useLock((s) => s.locked);
  const unlock = useLock((s) => s.unlock);
  const lock = useSettings((s) => s.lock);
  const [error, setError] = useState(false);
  const [fails, setFailsState] = useState(() => readFailsSync().fails);
  const [waitUntil, setWaitUntil] = useState(() => readFailsSync().until);
  const setFails = (f: number, until = 0) => { setFailsState(f); setWaitUntil(until); void writeFails(f, until); };
  // 載入後再和 IndexedDB 裡的紀錄合併（取較大的次數）
  useEffect(() => { void readFails().then((v) => { setFailsState((f) => Math.max(f, v.fails)); setWaitUntil((u) => Math.max(u, v.until)); }); }, []);
  const wipeOn = !!lock.wipeAfterFails;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!waitUntil) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [waitUntil]);

  const bio = async () => {
    try { if (await verifyBiometric()) { setFails(0); unlock(); } } catch { /* 使用者取消 */ }
  };
  useEffect(() => { if (locked && lock.webauthn) void bio(); }, [locked]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 忘記 PIN：用登入密碼確認是本人，就清除這台裝置的 PIN 並解鎖（之後可以到設定重新設定）。沒有帳號系統時只能清除本機資料。 */
  const forgot = async () => {
    if (!AUTH_ENABLED) {
      if (await ask('清除這台裝置的資料？沒有登入帳號時，忘記 PIN 只能清除本機資料重新開始，無法復原。', { confirmText: '清除' })) await wipeLocalData();
      return;
    }
    const ok = await confirmIdentity((body) => api('/auth/verify-password', { method: 'POST', body }), { title: '輸入登入密碼，清除 PIN', message: '確認是你本人後，會清除這台裝置的 PIN 並解鎖。', confirmText: '清除 PIN' });
    if (!ok) return;
    disableLock();
    setFails(0);
    unlock();
    useUI.getState().showSnack({ text: '已清除 PIN。要繼續保護畫面，請到「設定 → 隱私與安全」重新設定' });
  };

  if (!locked) return null;
  const waiting = waitUntil > now;
  return (
    <div className="lockscreen" role="dialog" aria-modal="true" aria-label="App 已鎖定">
      <img src={ICON_192} alt="" width={64} height={64} style={{ borderRadius: 14 }} />
      <h2 style={{ margin: '12px 0 4px' }}>輸入 PIN 碼</h2>
      <p className="muted" style={{ margin: 0, minHeight: 20 }}>{waiting ? `請稍候 ${Math.ceil((waitUntil - now) / 1000)} 秒` : error ? 'PIN 碼錯誤' : ''}</p>
      {wipeOn && fails >= WIPE_AT - 3 && <p role="alert" style={{ margin: '4px 0 0', color: 'var(--danger)', fontSize: '0.85rem' }}>再輸錯 {Math.max(0, WIPE_AT - fails)} 次，會登出並清除這台裝置的本機資料</p>}
      <PinPad error={error} disabled={waiting} onComplete={async (pin) => {
        if (await verifyPin(pin)) { setError(false); setFails(0); unlock(); return; }
        const f = fails + 1;
        if (wipeOn && f >= WIPE_AT) { setFails(f, 0); await wipeLocalData(); return; }
        const wait = lockoutMs(f);
        setFails(f, wait ? Date.now() + wait : 0);
        setError(true);
        setTimeout(() => setError(false), 600);
      }} />
      {lock.webauthn && <button className="btn tinted small" style={{ marginTop: 12 }} onClick={() => void bio()}>使用 Face ID／Touch ID</button>}
      <button className="lock-forgot" onClick={() => void forgot()}>忘記 PIN？</button>
    </div>
  );
}

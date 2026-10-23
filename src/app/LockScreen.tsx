/**
 * 鎖定畫面：6 位數 PIN（連錯 5 次需等待 30 秒，之後倍增）＋ Face ID／Touch ID。
 */
import { useEffect, useState } from 'react';
import { useLock, verifyBiometric, verifyPin } from '@/services/lock';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';

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

export function LockScreen() {
  const locked = useLock((s) => s.locked);
  const unlock = useLock((s) => s.unlock);
  const lock = useSettings((s) => s.lock);
  const [error, setError] = useState(false);
  const [fails, setFails] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
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

  if (!locked) return null;
  const waiting = waitUntil > now;
  return (
    <div className="lockscreen" role="dialog" aria-modal="true" aria-label="App 已鎖定">
      <img src="/icons/icon-192.png" alt="" width={64} height={64} style={{ borderRadius: 14 }} />
      <h2 style={{ margin: '12px 0 4px' }}>輸入 PIN 碼</h2>
      <p className="muted" style={{ margin: 0, minHeight: 20 }}>{waiting ? `請稍候 ${Math.ceil((waitUntil - now) / 1000)} 秒` : error ? 'PIN 碼錯誤' : ''}</p>
      <PinPad error={error} disabled={waiting} onComplete={async (pin) => {
        if (await verifyPin(pin)) { setError(false); setFails(0); unlock(); return; }
        const f = fails + 1;
        setFails(f);
        setError(true);
        setTimeout(() => setError(false), 600);
        if (f >= 5) setWaitUntil(Date.now() + 30000 * 2 ** (f - 5));
      }} />
      {lock.webauthn && <button className="btn tinted small" style={{ marginTop: 12 }} onClick={() => void bio()}>使用 Face ID／Touch ID</button>}
    </div>
  );
}

/**
 * 全域浮層：Snackbar（復原）、長按動作選單、新版本提示、背景隱私遮罩。
 */
import { ICON_192 } from '@/ui/assets';
import { useEffect, useRef, useState } from 'react';
import { useUI } from '@/stores/ui';
import { useSettings } from '@/stores/settings';
import { Sheet } from '@/ui/Sheet';

export function SnackbarHost() {
  const snack = useUI((s) => s.snack);
  const dismiss = useUI((s) => s.dismissSnack);
  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(dismiss, snack.duration ?? 3000);
    return () => clearTimeout(t);
  }, [snack, dismiss]);
  if (!snack) return null;
  return (
    <div className="snackbar-wrap" aria-live="polite">
      <div className="snackbar" key={snack.id} role="status">
        <span>{snack.text}</span>
        {snack.actionLabel && (
          <button onClick={() => { snack.onAction?.(); dismiss(); }}>{snack.actionLabel}</button>
        )}
      </div>
    </div>
  );
}

/**
 * 確認視窗（自製，取代瀏覽器／iOS 內建的 confirm）：置中的圓角卡片，點背景或按 Esc＝取消，
 * 預設焦點在「取消」（誤按 Enter 不會執行破壞性操作）。比一般彈窗層級更高，可疊在記帳面板上。
 */
export function ConfirmHost() {
  const c = useUI((s) => s.confirm);
  const close = useUI((s) => s.closeConfirm);
  const prevFocus = useRef<HTMLElement | null>(null);
  // 開啟前記住原本的焦點（按鈕或抽屜內的元件），關閉後還回去，鍵盤與讀屏使用者不會掉到頁面最上面
  useEffect(() => {
    if (!c) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    return () => { const el = prevFocus.current; prevFocus.current = null; setTimeout(() => el?.isConnected && el.focus?.({ preventScroll: true }), 0); };
  }, [c?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!c) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [c, close]);
  if (!c) return null;
  return (
    <div className="dlg-wrap" key={c.id}>
      <div className="dlg-backdrop" onClick={() => close(false)} aria-hidden="true" />
      <div className="dlg" role="alertdialog" aria-modal="true" aria-labelledby={`dlg-t-${c.id}`} aria-describedby={c.message ? `dlg-m-${c.id}` : undefined}>
        <div className="dlg-body">
          <h2 id={`dlg-t-${c.id}`}>{c.title}</h2>
          {c.message && <p id={`dlg-m-${c.id}`}>{c.message}</p>}
        </div>
        <div className="dlg-actions">
          <button autoFocus onClick={() => close(false)}>{c.cancelText ?? '取消'}</button>
          <button className={c.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{c.confirmText ?? '確定'}</button>
        </div>
      </div>
    </div>
  );
}

export function ActionSheetHost() {
  const actions = useUI((s) => s.actions);
  const close = useUI((s) => s.closeActions);
  return (
    <Sheet open={!!actions} onClose={close} title={actions?.title}>
      <div className="list">
        {actions?.items.map((it) => (
          <button key={it.label} className={`row${it.danger ? ' danger' : ''}`}
            onClick={() => { close(); setTimeout(it.onSelect, 120); }}>
            {it.icon && <span aria-hidden="true">{it.icon}</span>}
            <span className="row-main row-title" style={{ color: it.danger ? 'var(--danger)' : undefined }}>{it.label}</span>
          </button>
        ))}
      </div>
      <button className="btn secondary" onClick={close}>取消</button>
    </Sheet>
  );
}

/** Service Worker 更新提示：「有新版本，點擊更新」 */
export function UpdatePrompt() {
  const [update, setUpdate] = useState<null | ((reload?: boolean) => Promise<void>)>(null);
  const [offlineReady, setOfflineReady] = useState(false);
  useEffect(() => {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
    let cancelled = false;
    import('virtual:pwa-register').then(({ registerSW }) => {
      if (cancelled) return;
      const updateSW = registerSW({
        onNeedRefresh: () => setUpdate(() => updateSW),
        onOfflineReady: () => setOfflineReady(true),
        onRegisteredSW: (_url, reg) => {
          // 每 30 分鐘、以及回到前景時檢查更新
          if (!reg) return;
          setInterval(() => reg.update().catch(() => undefined), 30 * 60 * 1000);
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') reg.update().catch(() => undefined);
          });
        },
      });
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!offlineReady) return;
    useUI.getState().showSnack({ text: '已可離線使用 ✓' });
  }, [offlineReady]);
  if (!update) return null;
  return (
    <div className="banner" role="alert">
      <span>✨ 有新版本，點擊更新</span>
      <button className="btn small" onClick={() => update(true)}>更新</button>
      <button className="btn small secondary" onClick={() => setUpdate(null)}>稍後</button>
    </div>
  );
}

/** App 切到背景（App Switcher）時模糊畫面，避免金額外洩 */
export function PrivacyShield() {
  const enabled = useSettings((s) => s.blurOnHide);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const onVis = () => setHidden(document.visibilityState === 'hidden');
    const onBlur = () => setHidden(true);
    const onFocus = () => setHidden(false);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onBlur);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onBlur);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled]);
  if (!enabled || !hidden) return null;
  return (
    <div className="privacy-shield" aria-hidden="true">
      <img src={ICON_192} alt="" />
    </div>
  );
}

/**
 * 全域浮層：Snackbar（復原）、長按動作選單、新版本提示、背景隱私遮罩。
 */
import { ICON_192 } from '@/ui/assets';
import { useEffect, useState } from 'react';
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

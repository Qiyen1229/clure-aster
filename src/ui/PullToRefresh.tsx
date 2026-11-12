/**
 * 下拉重新整理：頁面捲到最上方時往下拉超過 70px 放開即觸發。只用 transform，60fps。
 */
import { useRef, useState, type ReactNode } from 'react';

/** Portal 彈窗的 touch 事件會沿 React 樹冒泡回頁面；來源是彈窗時不啟動下拉更新，避免「下滑關彈窗」同時觸發刷新 */
export function isOverlayTouch(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.sheet, .sheet-backdrop, .dlg-wrap, [role="dialog"], [role="alertdialog"]') !== null;
}

export function PullToRefresh({ onRefresh, children }: { onRefresh: () => Promise<unknown>; children: ReactNode }) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<number | null>(null);
  const TH = 70;

  return (
    <div
      onTouchStart={(e) => { if (window.scrollY <= 0 && !busy && !isOverlayTouch(e.target)) start.current = e.touches[0].clientY; }}
      onTouchMove={(e) => {
        if (start.current === null) return;
        const dy = e.touches[0].clientY - start.current;
        if (dy > 0) setPull(Math.min(110, dy * 0.5));
      }}
      onTouchCancel={() => {
        start.current = null;
        setPull(0);
      }}
      onTouchEnd={async () => {
        if (start.current === null) return;
        start.current = null;
        if (pull >= TH) {
          setBusy(true);
          setPull(56);
          navigator.vibrate?.(10);
          try { await onRefresh(); } finally { setBusy(false); setPull(0); }
        } else setPull(0);
      }}
    >
      <div className="ptr" style={{ height: pull, opacity: Math.min(1, pull / TH) }} aria-hidden={!busy}>
        <span className={`ptr-spinner${busy ? ' spin' : ''}`} style={{ transform: busy ? undefined : `rotate(${pull * 3}deg)` }} />
        <span className="muted" style={{ fontSize: '0.75rem' }}>{busy ? '更新中…' : pull >= TH ? '放開以更新' : '下拉更新'}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * 底部抽屜（Bottom Sheet）：視窗任何空白處或把手都能往下滑關閉（1:1 跟手、依速度與距離決定關閉或彈回）、
 * 點背景關閉、Esc 關閉、鎖定背景捲動。內容還能捲動時，捲動優先，不會誤關。
 * 關閉時先播放退出動畫再卸載。
 * 巢狀開啟時（例如記帳面板內再開帳戶選擇），後開的抽屜與其背景會疊在前一層之上，
 * 因此點任何空白處都只會關閉最上層，避免誤觸後無法退出。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  full?: boolean;
  children: ReactNode;
  /** 有未儲存內容時，下滑／點背景先詢問 */
  confirmClose?: () => boolean;
  labelledBy?: string;
}

/** 目前開啟中的抽屜堆疊（記錄 id，用來決定層級與 Esc 只關最上層） */
const stack: number[] = [];
let nextId = 1;

export function Sheet({ open, onClose, title, left, right, full, children, confirmClose }: Props) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const requestCloseRef = useRef<() => void>(() => {});
  const drag = useRef<{ y0: number; dy: number } | null>(null);
  const idRef = useRef(0);
  const [depth, setDepth] = useState(0);

  useEffect(() => {
    if (open) { setMounted(true); setClosing(false); }
    else if (mounted) {
      setClosing(true);
      const t = setTimeout(() => { setMounted(false); setClosing(false); }, 230);
      return () => clearTimeout(t);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mounted) return;
    const id = nextId++;
    idRef.current = id;
    stack.push(id);
    setDepth(stack.length);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && stack[stack.length - 1] === id) requestClose(); };
    window.addEventListener('keydown', onKey);
    // 焦點移入抽屜（無障礙）
    setTimeout(() => sheetRef.current?.focus({ preventScroll: true }), 50);
    return () => {
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      document.body.style.overflow = stack.length ? 'hidden' : prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  const requestClose = () => {
    if (confirmClose && !confirmClose()) return;
    onClose();
  };
  requestCloseRef.current = requestClose;

  // 空白處下滑關閉：原生 touch 事件（要能 preventDefault 擋掉頁面捲動），位移 1:1 跟著手指
  useEffect(() => {
    const el = sheetRef.current;
    if (!mounted || !el) return;
    const bd = backdropRef.current;
    type Mode = 'idle' | 'ignore' | 'drag';
    let mode: Mode = 'idle';
    let x0 = 0, y0 = 0, yBase = 0, dy = 0;
    let samples: { t: number; y: number }[] = [];

    const blocked = (target: EventTarget | null) => {
      let n = target as HTMLElement | null;
      if (n?.closest?.('.sheet-grab, input, textarea, select, [data-no-sheet-drag]')) return true;
      // 沿途有還沒捲到頂的可捲動區：讓它先捲
      while (n && n !== el) {
        if (n.nodeType === 1) {
          const oy = getComputedStyle(n).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1 && n.scrollTop > 0) return true;
        }
        n = n.parentElement;
      }
      return false;
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { mode = 'ignore'; return; }
      const t = e.touches[0];
      x0 = t.clientX; y0 = t.clientY; dy = 0;
      samples = [{ t: e.timeStamp, y: t.clientY }];
      mode = blocked(e.target) ? 'ignore' : 'idle';
    };
    const onMove = (e: TouchEvent) => {
      if (mode === 'ignore' || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (mode === 'idle') {
        const mx = t.clientX - x0, my = t.clientY - y0;
        if (Math.abs(mx) > Math.abs(my) && Math.abs(mx) > 6) { mode = 'ignore'; return; }
        if (my < -6) { mode = 'ignore'; return; }
        if (my <= 6) return;
        mode = 'drag';
        yBase = t.clientY; // 從啟動點開始算，畫面不會突然跳一格
        el.style.transition = 'none';
        el.style.animation = 'none';
        if (bd) bd.style.animation = 'none';
      }
      e.preventDefault();
      dy = Math.max(0, t.clientY - yBase);
      el.style.transform = `translateY(${dy}px)`;
      if (bd) bd.style.opacity = String(1 - Math.min(1, dy / (el.offsetHeight || 1)) * 0.9);
      samples.push({ t: e.timeStamp, y: t.clientY });
      if (samples.length > 8) samples.shift();
    };
    const onEnd = (e: TouchEvent) => {
      if (mode !== 'drag') { mode = 'idle'; return; }
      mode = 'idle';
      const last = samples[samples.length - 1];
      const ref = samples.find((p) => last.t - p.t <= 100) ?? last;
      const v = last.t > ref.t ? (last.y - ref.y) / (last.t - ref.t) : 0; // px/ms，向下為正
      const h = el.offsetHeight || 1;
      const shouldClose = e.type === 'touchend' && (dy > h * 0.28 || (v > 0.45 && dy > 24));
      if (shouldClose && (!confirmClose || confirmClose())) {
        // 關閉動畫從目前位置接著往下滑出（keyframe 只有 to，起點取當下的 transform）
        el.style.animation = '';
        el.style.transition = 'none';
        if (bd) bd.style.animation = '';
        requestCloseRef.current();
        return;
      }
      // 彈回原位
      el.style.animation = '';
      el.style.transition = 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)';
      el.style.transform = '';
      if (bd) { bd.style.transition = 'opacity 320ms ease'; bd.style.opacity = ''; }
      window.setTimeout(() => { el.style.transition = ''; if (bd) { bd.style.transition = ''; bd.style.animation = ''; } }, 340);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { y0: e.clientY, dy: 0 };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !sheetRef.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y0);
    sheetRef.current.style.transform = `translateY(${drag.current.dy}px)`;
    sheetRef.current.style.transition = 'none';
  };
  const onPointerUp = () => {
    if (!drag.current || !sheetRef.current) return;
    const { dy } = drag.current;
    drag.current = null;
    sheetRef.current.style.transition = 'transform 280ms var(--ease)';
    sheetRef.current.style.transform = '';
    if (dy > 110) requestClose();
  };

  if (!mounted) return null;
  // 每多一層 +2：背景蓋住下層抽屜，抽屜本身再高一層
  const z = 60 + Math.max(0, depth - 1) * 2;
  return createPortal(
    <>
      <div ref={backdropRef} className={`sheet-backdrop${closing ? ' closing' : ''}`} style={{ zIndex: z }}
        onClick={requestClose} onPointerDown={(e) => e.stopPropagation()} aria-hidden="true" />
      <div ref={sheetRef} className={`sheet${full ? ' full' : ''}${closing ? ' closing' : ''}`} style={{ zIndex: z + 1 }}
        role="dialog" aria-modal="true" tabIndex={-1} aria-label={typeof title === 'string' ? title : undefined}>
        <div className="sheet-grab" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
        {(title || left || right) && (
          <div className="sheet-head">
            <div style={{ minWidth: 44 }}>{left ?? (
              <button className="icon-btn plain" onClick={requestClose} aria-label="關閉"><Icon name="close" /></button>
            )}</div>
            <h2>{title}</h2>
            <div style={{ minWidth: 44, display: 'flex', justifyContent: 'flex-end' }}>{right}</div>
          </div>
        )}
        <div className="sheet-body">{children}</div>
      </div>
    </>,
    document.body,
  );
}

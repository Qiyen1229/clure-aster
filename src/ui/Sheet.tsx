/**
 * 底部抽屜（Bottom Sheet）：拖曳把手下滑關閉、點背景（空白處）關閉、Esc 關閉、鎖定背景捲動。
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
      <div className={`sheet-backdrop${closing ? ' closing' : ''}`} style={{ zIndex: z }}
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

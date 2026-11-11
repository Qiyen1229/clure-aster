/**
 * 說明文字浮窗：標題旁一顆 ⓘ，點開跳出置中卡片浮窗，附帶「知道了」關閉按鈕。
 *  - Hint：卡片標題＋ⓘ（可在右側放按鈕），點擊跳出說明浮窗
 *  - Intro：獨立的一行「ⓘ 說明」按鈕，點擊跳出說明浮窗
 *  - LabelHint：表單列的名稱＋ⓘ，點擊跳出說明浮窗（右邊開關不受影響）
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

interface InfoModalProps {
  title: ReactNode;
  content: ReactNode;
  onClose: () => void;
}

export function InfoModal({ title, content, onClose }: InfoModalProps) {
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    btnRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="dlg-wrap hint-modal-wrap" style={{ zIndex: 320 }}>
      <div className="dlg-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="dlg hint-dialog" role="dialog" aria-modal="true">
        <div className="hint-dialog-body">
          {title && <h3 className="hint-dialog-title">{title}</h3>}
          <div className="hint-dialog-content">{content}</div>
        </div>
        <div className="hint-dialog-actions">
          <button
            ref={btnRef}
            type="button"
            className="hint-dialog-btn"
            onClick={onClose}
          >
            知道了
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Hint({ id: _id, title, hint, right }: { id: string; title: ReactNode; hint?: ReactNode; right?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="hint-head">
        <div className="row-title" style={{ whiteSpace: 'normal' }}>{title}</div>
        {hint && (
          <button
            type="button"
            className="hint-btn"
            aria-label="說明"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(true);
            }}
          >
            <Icon name="info" />
          </button>
        )}
        {right && <><span className="hint-spacer" /><div onClick={(e) => e.stopPropagation()}>{right}</div></>}
      </div>
      {open && hint && <InfoModal title={title} content={hint} onClose={() => setOpen(false)} />}
    </>
  );
}

export function Intro({ id: _id, children, label = '說明' }: { id: string; children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="intro-toggle"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Icon name="info" />{label}
      </button>
      {open && <InfoModal title={label} content={children} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 表單列的名稱＋ⓘ；點擊跳出置中浮窗說明，右邊開關不受影響 */
export function LabelHint({ id: _id, label, hint }: { id: string; label: ReactNode; hint: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="label" style={{ flex: 1, minWidth: 0 }}>
        <span className="hint-head" style={{ display: 'flex' }}>
          <span>{label}</span>
          <button
            type="button"
            className="hint-btn"
            aria-label={`${typeof label === 'string' ? label : ''}說明`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(true);
            }}
          >
            <Icon name="info" />
          </button>
        </span>
      </span>
      {open && <InfoModal title={label} content={hint} onClose={() => setOpen(false)} />}
    </>
  );
}

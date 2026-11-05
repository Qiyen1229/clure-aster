/**
 * 說明文字可折疊：標題旁一顆 ⓘ，點開才看到小字介紹；展開狀態記在這台裝置（localStorage，失敗也不影響使用）。
 *  - Hint：卡片標題＋ⓘ（可在右側放按鈕），說明在標題下方展開
 *  - Intro：獨立的一段說明（例如設定各組底下的長說明），收成「ⓘ 說明」一行
 *  - LabelHint：表單列的名稱＋ⓘ，說明在名稱下方展開（右邊的開關不受影響）
 */
import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

const KEY = (id: string) => `aster.hint.${id}`;
const read = (id: string) => { try { return localStorage.getItem(KEY(id)) === '1'; } catch { return false; } };

function useOpen(id: string) {
  const [open, setOpen] = useState(() => read(id));
  const toggle = () => setOpen((o) => { try { localStorage.setItem(KEY(id), o ? '0' : '1'); } catch { /* 忽略 */ } return !o; });
  return [open, toggle] as const;
}

function Body({ open, bodyId, children, className }: { open: boolean; bodyId: string; children: ReactNode; className?: string }) {
  return <div className={`hint-body${open ? ' open' : ''}${className ? ` ${className}` : ''}`} id={bodyId}><div className="hint-inner">{children}</div></div>;
}

const InfoBtn = ({ open, onClick, bodyId, label }: { open: boolean; onClick: () => void; bodyId: string; label: string }) => (
  <button type="button" className="hint-btn" aria-expanded={open} aria-controls={bodyId} aria-label={label} onClick={onClick}><Icon name="info" /></button>
);

export function Hint({ id, title, hint, right }: { id: string; title: ReactNode; hint?: ReactNode; right?: ReactNode }) {
  const [open, toggle] = useOpen(id);
  const bodyId = useId();
  return (
    <>
      <div className="hint-head">
        <div className="row-title" style={{ whiteSpace: 'normal' }}>{title}</div>
        {hint && <InfoBtn open={open} onClick={toggle} bodyId={bodyId} label="說明" />}
        {right && <><span className="hint-spacer" />{right}</>}
      </div>
      {hint && <Body open={open} bodyId={bodyId}><p>{hint}</p></Body>}
    </>
  );
}

export function Intro({ id, children, label = '說明' }: { id: string; children: ReactNode; label?: string }) {
  const [open, toggle] = useOpen(id);
  const bodyId = useId();
  return (
    <>
      <button type="button" className="intro-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}><Icon name="info" />{label}</button>
      <Body open={open} bodyId={bodyId} className="intro-body"><p>{children}</p></Body>
    </>
  );
}

/** 表單列的名稱＋ⓘ；放在 `.field` 裡取代原本的 `<span className="label">名稱<span className="row-sub">…</span></span>` */
export function LabelHint({ id, label, hint }: { id: string; label: ReactNode; hint: ReactNode }) {
  const [open, toggle] = useOpen(id);
  const bodyId = useId();
  return (
    <span className="label" style={{ flex: 1, minWidth: 0 }}>
      <span className="hint-head" style={{ display: 'flex' }}><span>{label}</span><InfoBtn open={open} onClick={toggle} bodyId={bodyId} label={`${typeof label === 'string' ? label : ''}說明`} /></span>
      <Body open={open} bodyId={bodyId}><span className="row-sub" style={{ display: 'block', margin: '4px 0 2px' }}>{hint}</span></Body>
    </span>
  );
}

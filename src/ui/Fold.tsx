/**
 * 可折疊的區塊：小標題（可附一行小字介紹）＋ 內容。設定頁各組、各子頁的段落都用它，畫面不會一次展開太多。
 * 展開狀態記在這台裝置（localStorage，只是方便，讀寫失敗也不影響使用）；展開／收合用 grid 行高動畫，不觸發逐幀排版。
 */
import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { NewMark } from './NewMark';

const KEY = (id: string) => `aster.fold.${id}`;
const read = (id: string, fallback: boolean) => { try { const v = localStorage.getItem(KEY(id)); return v === null ? fallback : v === '1'; } catch { return fallback; } };

export function Fold({ id, title, desc, newSince, defaultOpen = false, children }: {
  /** 同一頁內唯一；用來記住展開狀態 */
  id: string;
  title: ReactNode;
  /** 標題下方一行小字介紹（收合時也看得到） */
  desc?: ReactNode;
  /** 新功能：給版本號（例如 '4.0.0'），標題前會出現閃亮符號，過兩個版本自動消失 */
  newSince?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => read(id, defaultOpen));
  const bodyId = useId();
  const toggle = () => setOpen((o) => { try { localStorage.setItem(KEY(id), o ? '0' : '1'); } catch { /* 忽略 */ } return !o; });
  return (
    <section className={`fold${open ? ' open' : ''}`}>
      <button type="button" className="fold-head" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
        <span className="fold-text">
          <span className="fold-title">{newSince && <NewMark since={newSince} />}{title}</span>
          {desc && <span className="fold-desc">{desc}</span>}
        </span>
        <Icon name="chevronD" size={18} className="fold-chev" />
      </button>
      <div className="fold-body" id={bodyId}>
        <div className="fold-inner">{children}</div>
      </div>
    </section>
  );
}

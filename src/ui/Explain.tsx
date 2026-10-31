/**
 * 「為什麼這樣算？」：小小的 ⓘ 按鈕，點開顯示這個數字實際帶入的公式與數值（全部在本機算，不經 AI）。
 * rows：算式中的每一項（label／value）；formula：一行公式；notes：補充說明。
 */
import { useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { Icon } from './Icon';

export interface ExplainRow { label: ReactNode; value: ReactNode; strong?: boolean }

export function ExplainButton({ title, formula, rows, notes }: { title: string; formula: string; rows?: ExplainRow[]; notes?: ReactNode[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="explain-btn" aria-label={`為什麼這樣算：${title}`} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        <Icon name="info" size={15} />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="為什麼這樣算？">
        <div className="explain-body">
          <h3 className="explain-title">{title}</h3>
          <pre className="explain-formula num">{formula}</pre>
          {rows && rows.length > 0 && (
            <div className="list" style={{ marginTop: 12 }}>
              {rows.map((r, i) => (
                <div className="row" key={i}>
                  <span className="row-main" style={r.strong ? { fontWeight: 650 } : undefined}>{r.label}</span>
                  <span className="num" style={r.strong ? { fontWeight: 650 } : undefined}>{r.value}</span>
                </div>
              ))}
            </div>
          )}
          {notes?.map((n, i) => <p key={i} className="muted explain-note">{n}</p>)}
          <p className="muted explain-note">以上都是用你這台裝置上的資料直接計算，沒有送給任何 AI 或伺服器。</p>
        </div>
      </Sheet>
    </>
  );
}

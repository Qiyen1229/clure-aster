/**
 * 首頁左上角的月份選擇：自己的抽屜（年份左右切換＋12 個月份），不依賴瀏覽器的日期選擇器
 * （iPhone 主畫面 App 裡隱藏的 <input type="date"> 常常叫不出選擇器）。
 */
import { useEffect, useState } from 'react';
import { Sheet } from '@/ui/Sheet';
import { Icon } from '@/ui/Icon';
import { todayKey } from '@/domain/period';

interface Props {
  open: boolean;
  onClose: () => void;
  year: number;
  month0: number;
  onPick: (year: number, month0: number) => void;
}

export function MonthPicker({ open, onClose, year, month0, onPick }: Props) {
  const [viewYear, setViewYear] = useState(year);
  useEffect(() => { if (open) setViewYear(year); }, [open, year]); // 每次打開都從目前的年份開始
  const today = new Date(todayKey().replace(/-/g, '/'));
  const ty = today.getFullYear(), tm = today.getMonth();
  return (
    <Sheet open={open} onClose={onClose} title="選擇月份">
      <div className="mp-body">
        <div className="mp-year">
          <button className="icon-btn" aria-label="上一年" onClick={() => setViewYear((y) => y - 1)}><Icon name="chevronL" /></button>
          <b className="num">{viewYear} 年</b>
          <button className="icon-btn" aria-label="下一年" onClick={() => setViewYear((y) => y + 1)}><Icon name="chevronR" /></button>
        </div>
        <div className="mp-grid" role="listbox" aria-label="月份">
          {Array.from({ length: 12 }, (_, m) => {
            const sel = viewYear === year && m === month0;
            const cur = viewYear === ty && m === tm;
            return (
              <button key={m} role="option" aria-selected={sel} className={`mp-cell${sel ? ' selected' : ''}${cur ? ' current' : ''}`}
                onClick={() => { onPick(viewYear, m); onClose(); }}>
                {m + 1} 月
              </button>
            );
          })}
        </div>
        <button className="btn tinted" style={{ width: '100%', marginTop: 12 }} onClick={() => { onPick(ty, tm); onClose(); }}>回到本月</button>
      </div>
    </Sheet>
  );
}

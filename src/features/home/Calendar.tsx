/**
 * 月曆網格：週日～週六（或週一起始）、上下月日期淡化、選取日主題色圓框、
 * 有紀錄的日期下方顯示小圓點（支出主題色／收入漲色），並以熱度底色顯示花費高低。
 * 左右滑動切換月份；可收合成「只顯示選取週」。
 */
import { useMemo, useRef, useState } from 'react';
import { monthGrid, todayKey, type CalendarCell } from '@/domain/period';
import type { Totals } from '@/domain/ledger';

const WEEK_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

interface Props {
  year: number;
  month0: number;
  selected: string;
  weekStart: 0 | 1;
  dayTotals: Map<string, Totals>;
  daysWithRecords: Set<string>;
  collapsed: boolean;
  onSelect: (key: string) => void;
  onMonthShift: (delta: number) => void;
}

export function Calendar({ year, month0, selected, weekStart, dayTotals, daysWithRecords, collapsed, onSelect, onMonthShift }: Props) {
  const cells = useMemo(() => monthGrid(year, month0, weekStart), [year, month0, weekStart]);
  const today = todayKey();
  const [anim, setAnim] = useState<'' | 'l' | 'r'>('');
  const touch = useRef<{ x: number; y: number } | null>(null);

  const labels = weekStart === 1 ? [...WEEK_LABELS.slice(1), WEEK_LABELS[0]] : WEEK_LABELS;

  // 熱度：以當月單日最大支出為 1
  const maxExpense = useMemo(() => {
    let m = 0;
    for (const c of cells) if (c.inMonth) m = Math.max(m, dayTotals.get(c.key)?.expense ?? 0);
    return m;
  }, [cells, dayTotals]);

  const shift = (d: number) => {
    setAnim(d > 0 ? 'l' : 'r');
    onMonthShift(d);
  };

  const selectedRow = Math.floor(Math.max(0, cells.findIndex((c) => c.key === selected)) / 7);
  const visible: CalendarCell[] = collapsed ? cells.slice(selectedRow * 7, selectedRow * 7 + 7) : cells;

  return (
    <div className="cal"
      onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
      onTouchEnd={(e) => {
        if (!touch.current) return;
        const dx = e.changedTouches[0].clientX - touch.current.x;
        const dy = e.changedTouches[0].clientY - touch.current.y;
        touch.current = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) shift(dx < 0 ? 1 : -1);
      }}>
      <div className="cal-week" aria-hidden="true">
        {labels.map((l) => <span key={l}>{l}</span>)}
      </div>
      <div key={`${year}-${month0}-${collapsed}`} className={`cal-grid${anim ? ` month-anim-${anim}` : ''}`} role="grid"
        aria-label={`${year} 年 ${month0 + 1} 月`} onAnimationEnd={() => setAnim('')}>
        {visible.map((c) => {
          const t = dayTotals.get(c.key);
          const has = daysWithRecords.has(c.key);
          const heat = c.inMonth && maxExpense > 0 && t?.expense ? 0.05 + 0.2 * (t.expense / maxExpense) : 0;
          const cls = ['cal-cell', c.inMonth ? '' : 'out', c.key === today ? 'today' : '', c.key === selected ? 'selected' : '',
            c.weekday === 0 || c.weekday === 6 ? 'weekend' : ''].join(' ');
          return (
            <button key={c.key} className={cls} role="gridcell" aria-selected={c.key === selected}
              aria-label={`${c.key}${has ? '，有紀錄' : ''}`} onClick={() => onSelect(c.key)}>
              <span className="heat" style={{ ['--heat' as string]: heat }} />
              <span className="d num">{c.day === 1 ? `${Number(c.key.slice(5, 7))}月` : String(c.day).padStart(2, '0')}</span>
              {has && (
                <span className="dots" aria-hidden="true">
                  {(t?.expense ?? 0) > 0 && <i />}
                  {(t?.income ?? 0) > 0 && <i className="inc" />}
                  {!t?.expense && !t?.income && <i style={{ background: 'var(--text-3)' }} />}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

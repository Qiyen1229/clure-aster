/**
 * Aster 膠囊週曆（Weekly Glance Strip）與全月展開檢視。
 * - 採用 3 頁式 GPU 硬體加速軌道（translate3d），手指與滑鼠拖曳時 0 React 渲染，即時跟隨。
 * - 放開時依手指速度決定動畫長短（快甩就快、慢放就柔和），動畫結束後在同一個畫面更新內換內容並歸位，不會閃一下。
 * - 週曆 ⇄ 整月：容器高度用 WAAPI 平滑展開／收合，舊內容留一份「殘影」淡出、新內容從選取日那一列的位置滑開，像 iOS 行事曆。
 * - 微型小光點（•）採絕對定位鎖定底部基準線，藍點（支出）與紅點（收入）保證像素級水平置中。
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { addDays, fromDateKey, monthGrid, todayKey, weekRange, type CalendarCell } from '@/domain/period';
import type { Totals } from '@/domain/ledger';
import { Icon } from '@/ui/Icon';

const SHORT_WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

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
  onWeekShift: (delta: number) => void;
  onToggleCollapse: () => void;
}

export function Calendar({
  year,
  month0,
  selected,
  weekStart,
  dayTotals,
  daysWithRecords,
  collapsed,
  onSelect,
  onMonthShift,
  onWeekShift,
  onToggleCollapse,
}: Props) {
  const today = todayKey();

  // 星期標籤順序
  const orderedLabels = useMemo(() => {
    return weekStart === 1
      ? [...SHORT_WEEK_LABELS.slice(1), SHORT_WEEK_LABELS[0]]
      : SHORT_WEEK_LABELS;
  }, [weekStart]);

  // 週曆 3 頁：前一週、當週、下一週
  const { prevWeekDays, currWeekDays, nextWeekDays } = useMemo(() => {
    const { start: currStart } = weekRange(selected, weekStart);
    const prevStart = addDays(currStart, -7);
    const nextStart = addDays(currStart, 7);
    return {
      prevWeekDays: Array.from({ length: 7 }, (_, i) => addDays(prevStart, i)),
      currWeekDays: Array.from({ length: 7 }, (_, i) => addDays(currStart, i)),
      nextWeekDays: Array.from({ length: 7 }, (_, i) => addDays(nextStart, i)),
    };
  }, [selected, weekStart]);

  // 月曆 3 頁：前一月、當月、下一月
  const { prevMonthCells, currMonthCells, nextMonthCells, prevLabel, currLabel, nextLabel } = useMemo(() => {
    const p = new Date(year, month0 - 1, 1);
    const n = new Date(year, month0 + 1, 1);
    const pY = p.getFullYear();
    const pM = p.getMonth();
    const nY = n.getFullYear();
    const nM = n.getMonth();

    return {
      prevMonthCells: monthGrid(pY, pM, weekStart),
      currMonthCells: monthGrid(year, month0, weekStart),
      nextMonthCells: monthGrid(nY, nM, weekStart),
      prevLabel: `${pY} 年 ${pM + 1} 月`,
      currLabel: `${year} 年 ${month0 + 1} 月`,
      nextLabel: `${nY} 年 ${nM + 1} 月`,
    };
  }, [year, month0, weekStart]);

  // DOM 軌道與手勢控制
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const morph = useRef<{ ghost: HTMLElement; oldH: number; oldTop: number; oldVpH: number; row: number } | null>(null);

  const dragStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const last = useRef({ x: 0, t: 0, v: 0 });
  const isDragging = useRef(false);
  const isAnimating = useRef(false);
  const justSwiped = useRef(false);
  const wheelLock = useRef<number>(0);

  // 滑動轉場：先播完位移動畫，動畫結束後「同一個畫面更新」內才換內容並把軌道歸位（見下方 useLayoutEffect），
  // 不會出現舊內容閃一下的跳動。放開時依手指速度決定動畫長短，快甩就快、慢放就柔和。
  const settle = useRef<(() => void) | null>(null);
  const animateTo = (dir: 1 | -1 | 0, velocity = 0) => {
    if (!viewportRef.current || !trackRef.current) return;
    const width = viewportRef.current.clientWidth;
    const track = trackRef.current;
    isAnimating.current = true;

    const targetPx = dir === 1 ? -2 * width : dir === -1 ? 0 : -width;
    const current = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
    const remain = Math.abs(targetPx - current);
    // 剩餘距離 ÷ 速度（px/ms）；限制在 180～380ms
    const ms = Math.round(Math.min(380, Math.max(180, velocity > 0.2 ? remain / velocity : 120 + remain * 0.7)));
    track.style.transition = `transform ${ms}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    track.style.transform = `translate3d(${targetPx}px, 0, 0)`;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      track.removeEventListener('transitionend', onEnd);
      window.clearTimeout(fallback);
      if (dir === 0) {
        track.style.transition = 'none';
        isAnimating.current = false;
        return;
      }
      // 換內容；軌道歸位由 useLayoutEffect 在內容更新的同一個 commit 完成
      settle.current = () => { settle.current = null; };
      if (collapsed) onWeekShift(dir);
      else onMonthShift(dir);
      // 保險：父層狀態沒變（沒有觸發重繪）時也要歸位
      requestAnimationFrame(() => requestAnimationFrame(() => { if (settle.current) resetTrack(); }));
    };
    const onEnd = (e: TransitionEvent) => { if (e.target === track && e.propertyName === 'transform') finish(); };
    track.addEventListener('transitionend', onEnd);
    const fallback = window.setTimeout(finish, ms + 80);
  };

  const resetTrack = () => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = 'none';
    track.style.transform = 'translate3d(-33.333333%, 0, 0)';
    settle.current = null;
    isAnimating.current = false;
  };
  // 日期或月份換了、新內容已經在 DOM 裡：同一個畫面立刻把軌道歸位到中間頁
  useLayoutEffect(() => { if (isAnimating.current) resetTrack(); }, [selected, year, month0, collapsed, weekStart]);

  // 展開／收合：先記下舊內容（殘影）與高度，狀態換掉後在同一個 commit 內開始動畫
  const toggle = () => {
    const c = containerRef.current, vp = viewportRef.current;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (c && vp && typeof c.animate === 'function' && !reduce) {
      c.getAnimations().forEach((a) => a.finish()); // 上一段還沒播完就先收尾
      const ghost = vp.cloneNode(true) as HTMLElement;
      ghost.setAttribute('aria-hidden', 'true');
      ghost.querySelectorAll('button').forEach((b) => b.setAttribute('tabindex', '-1'));
      const idx = collapsed ? -1 : currMonthCells.findIndex((x) => x.key === selected);
      morph.current = { ghost, oldH: c.offsetHeight, oldTop: vp.offsetTop, oldVpH: vp.offsetHeight, row: idx >= 0 ? Math.floor(idx / 7) : 0 };
    }
    onToggleCollapse();
  };
  useLayoutEffect(() => {
    const m = morph.current;
    morph.current = null;
    const c = containerRef.current, vp = viewportRef.current;
    if (!m || !c || !vp) return;
    const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'; // iOS 的減速曲線：順、不彈
    const D = 460;
    const newH = c.offsetHeight;
    const newTop = vp.offsetTop;
    const expanding = !collapsed;
    // 選取日那一列：展開時在新月曆裡，收合時在舊月曆（殘影）裡
    const idx = expanding ? currMonthCells.findIndex((x) => x.key === selected) : -1;
    const row = expanding ? Math.max(0, Math.floor(idx / 7)) : m.row;
    const rowH = (expanding ? vp.offsetHeight : m.oldVpH) / 6;
    const dTop = m.oldTop - newTop;
    c.style.overflow = 'hidden';
    const hAnim = c.animate([{ height: `${m.oldH}px` }, { height: `${newH}px` }], { duration: D, easing: EASE });
    const clean = () => { c.style.overflow = ''; m.ghost.remove(); };
    hAnim.onfinish = clean;
    hAnim.oncancel = clean;
    // 殘影：留在原位，往「選取日那一列」的位置收攏並淡出
    const gh = m.ghost;
    gh.style.position = 'absolute'; gh.style.left = '0'; gh.style.right = '0'; gh.style.top = `${m.oldTop}px`; gh.style.pointerEvents = 'none';
    c.appendChild(gh);
    const ghostTo = expanding ? newTop - m.oldTop + row * rowH : -row * rowH;
    gh.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${ghostTo}px)`, opacity: 0 }], { duration: D, easing: EASE, fill: 'forwards' });
    // 新內容：從「選取日那一列」目前的位置滑開並淡入
    const vpFrom = expanding ? dTop - row * rowH : dTop + row * rowH;
    vp.animate([{ transform: `translateY(${vpFrom}px)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: D, easing: EASE });
    c.querySelector('.cal-week-header')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: D, easing: EASE });
    // 展開／收合鈕跟著容器底邊走，不會先消失再冒出來
    c.querySelector('.cal-toggle-bar')?.animate([{ transform: `translateY(${m.oldH - newH}px)` }, { transform: 'translateY(0)' }], { duration: D, easing: EASE });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  // 指標按下（滑鼠、觸控）
  const handlePointerDown = (e: React.PointerEvent) => {
    if (isAnimating.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragStart.current = { x: e.clientX, y: e.clientY, time: performance.now() };
    last.current = { x: e.clientX, t: performance.now(), v: 0 };
    isDragging.current = false;
  };

  // 指標移動（直接更新 DOM transform，0 React 重新渲染）
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current || isAnimating.current || !viewportRef.current || !trackRef.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;

    if (!isDragging.current) {
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.1) {
        isDragging.current = true;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    }

    if (isDragging.current) {
      const now = performance.now();
      const dt = now - last.current.t;
      if (dt > 0) last.current = { x: e.clientX, t: now, v: 0.8 * last.current.v + 0.2 * ((e.clientX - last.current.x) / dt) };
      else last.current.x = e.clientX;
      const width = viewportRef.current.clientWidth;
      trackRef.current.style.transition = 'none';
      trackRef.current.style.transform = `translate3d(${-width + dx}px, 0, 0)`;
    }
  };

  // 指標放開：位移夠大或甩得夠快就換頁，否則彈回
  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragStart.current || isAnimating.current) return;
    const dx = e.clientX - dragStart.current.x;
    const wasDrag = isDragging.current;
    const v = last.current.v; // px/ms，往右為正

    dragStart.current = null;
    isDragging.current = false;

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    if (wasDrag) {
      justSwiped.current = true;
      window.setTimeout(() => { justSwiped.current = false; }, 80);
      const width = viewportRef.current?.clientWidth ?? 320;
      const flick = Math.abs(v) > 0.45; // 甩動
      if (dx < -width * 0.18 || (flick && v < 0 && dx < -8)) animateTo(1, Math.abs(v));
      else if (dx > width * 0.18 || (flick && v > 0 && dx > 8)) animateTo(-1, Math.abs(v));
      else animateTo(0, Math.abs(v));
    }
  };

  // 觸控板左右滑動（Mac 雙指水平捲動）
  const handleWheel = (e: React.WheelEvent) => {
    if (isAnimating.current || isDragging.current) return;
    if (Date.now() < wheelLock.current) return;
    if (Math.abs(e.deltaX) > 22 && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.2) {
      wheelLock.current = Date.now() + 380;
      animateTo(e.deltaX > 0 ? 1 : -1);
    }
  };

  // 繪製單週 7 天膠囊
  const renderWeekSlide = (days: string[], selDate: string) => (
    <div className="cal-week-strip" role="row" aria-label="週曆">
      {days.map((k) => {
        const d = fromDateKey(k);
        const dayNum = d.getDate();
        const weekday = d.getDay();
        const isToday = k === today;
        const isSelected = k === selDate;
        const has = daysWithRecords.has(k);
        const t = dayTotals.get(k);
        const hasExp = (t?.expense ?? 0) > 0;
        const hasInc = (t?.income ?? 0) > 0;
        const isWeekend = weekday === 0 || weekday === 6;

        return (
          <button
            key={k}
            className={`cal-pill ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''} ${isWeekend ? 'weekend' : ''}`}
            onClick={(e) => {
              if (justSwiped.current || isAnimating.current) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              onSelect(k);
            }}
            aria-selected={isSelected}
            aria-label={`${k}${has ? '，有紀錄' : ''}`}
          >
            <span className="cal-pill-day">{SHORT_WEEK_LABELS[weekday]}</span>
            <span className="cal-pill-num num">{dayNum}</span>
            <span className="cal-pill-dots" aria-hidden="true">
              {hasExp && <i className="dot exp" />}
              {hasInc && <i className="dot inc" />}
              {!hasExp && !hasInc && has && <i className="dot other" />}
            </span>
          </button>
        );
      })}
    </div>
  );

  // 繪製單月 42 格
  const renderMonthSlide = (cells: CalendarCell[], selDate: string, label: string) => (
    <div className="cal-grid" role="grid" aria-label={label}>
      {cells.map((c) => {
        const t = dayTotals.get(c.key);
        const has = daysWithRecords.has(c.key);
        const hasExp = (t?.expense ?? 0) > 0;
        const hasInc = (t?.income ?? 0) > 0;
        const isToday = c.key === today;
        const isSelected = c.key === selDate;
        const isWeekend = c.weekday === 0 || c.weekday === 6;

        return (
          <button
            key={c.key}
            className={`cal-grid-cell ${c.inMonth ? '' : 'out'} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${isWeekend ? 'weekend' : ''}`}
            role="gridcell"
            aria-selected={isSelected}
            aria-label={`${c.key}${has ? '，有紀錄' : ''}`}
            onClick={(e) => {
              if (justSwiped.current || isAnimating.current) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              onSelect(c.key);
            }}
          >
            <span className="cal-grid-num num">
              {c.day === 1 ? `${Number(c.key.slice(5, 7))}月` : c.day}
            </span>
            <span className="cal-pill-dots" aria-hidden="true">
              {hasExp && <i className="dot exp" />}
              {hasInc && <i className="dot inc" />}
              {!hasExp && !hasInc && has && <i className="dot other" />}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className="cal-container"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
    >
      {!collapsed && (
        <div className="cal-week-header" aria-hidden="true">
          {orderedLabels.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      )}

      {/* 3 頁式 GPU 硬體加速視口 */}
      <div ref={viewportRef} className="cal-viewport">
        <div ref={trackRef} className="cal-track">
          {collapsed ? (
            <>
              <div className="cal-slide">{renderWeekSlide(prevWeekDays, addDays(selected, -7))}</div>
              <div className="cal-slide">{renderWeekSlide(currWeekDays, selected)}</div>
              <div className="cal-slide">{renderWeekSlide(nextWeekDays, addDays(selected, 7))}</div>
            </>
          ) : (
            <>
              <div className="cal-slide">{renderMonthSlide(prevMonthCells, '', prevLabel)}</div>
              <div className="cal-slide">{renderMonthSlide(currMonthCells, selected, currLabel)}</div>
              <div className="cal-slide">{renderMonthSlide(nextMonthCells, '', nextLabel)}</div>
            </>
          )}
        </div>
      </div>

      {/* 控制列：左右切換箭頭 + 展開／收合開關 */}
      <div className="cal-toggle-bar">
        <button
          className="cal-nav-arrow-btn"
          onClick={(e) => {
            e.stopPropagation();
            animateTo(-1);
          }}
          aria-label={collapsed ? '上一週' : '上一月'}
          title={collapsed ? '上一週' : '上一月'}
        >
          <Icon name="chevronL" size={14} />
        </button>

        <button
          className="cal-toggle-btn"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展開整月' : '收合為週曆'}
        >
          <span>{collapsed ? '展開整月' : '收合為週曆'}</span>
          <Icon name={collapsed ? 'chevronD' : 'up'} size={13} />
        </button>

        <button
          className="cal-nav-arrow-btn"
          onClick={(e) => {
            e.stopPropagation();
            animateTo(1);
          }}
          aria-label={collapsed ? '下一週' : '下一月'}
          title={collapsed ? '下一週' : '下一月'}
        >
          <Icon name="chevronR" size={14} />
        </button>
      </div>
    </div>
  );
}

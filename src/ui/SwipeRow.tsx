/**
 * 可滑動的列：左滑 → 刪除（紅）、右滑 → 編輯；長按 → 快捷選單。
 * 用 Pointer Events + transform 實作，只動 GPU 合成層，維持 60fps。
 * 垂直捲動優先：移動前 10px 若垂直位移較大，交還給瀏覽器捲動。
 */
import { useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

const THRESHOLD = 88;
const LONG_PRESS_MS = 480;

interface Props {
  children: ReactNode;
  onTap?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /** 放在 .list 裡面：不要自己的圓角與下方間距 */
  flat?: boolean;
  /** 左滑超過門檻後，不是原地消失，而是整列「縮起來」（高度、間距、透明度一起收到 0）再呼叫 onDelete；用在「隱藏」這類動作 */
  collapse?: boolean;
  /** 左滑時露出的動作文字與圖示（預設是紅色的「刪除」＋垃圾桶）；給了就改成中性色 */
  action?: { label: string; icon: IconName };
}

export function SwipeRow({ children, onTap, onEdit, onDelete, onLongPress, disabled, flat, collapse, action }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const st = useRef<{ x0: number; y0: number; dx: number; mode: 'idle' | 'h' | 'v'; timer?: number; long: boolean } | null>(null);

  const set = (x: number, animate = false) => {
    const el = ref.current;
    if (!el) return;
    el.classList.toggle('animating', animate);
    el.style.transform = x ? `translate3d(${x}px,0,0)` : '';
    if (wrap.current) {
      if (x !== 0) wrap.current.dataset.dir = x > 0 ? 'r' : 'l';
      else wrap.current.removeAttribute('data-dir');
      // 只有真的在滑動時才顯示底下的編輯／刪除色塊；平常藏起來，不然圓角邊緣會透出紅色
      wrap.current.toggleAttribute('data-active', x !== 0);
    }
  };

  /** 整列縮起來：先固定目前高度，再把高度與上下間距收到 0（連同容器的 gap 一起），收完才通知呼叫端 */
  const collapseThen = (done: () => void) => {
    const w = wrap.current;
    if (!w) { done(); return; }
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { done(); return; }
    const gap = parseFloat(getComputedStyle(w.parentElement ?? w).rowGap) || 0;
    w.style.height = `${w.offsetHeight}px`;
    w.style.transition = 'height 300ms var(--ease), margin 300ms var(--ease), opacity 240ms ease';
    void w.offsetHeight; // 強制重排，讓上面的起始高度生效
    w.style.height = '0px';
    w.style.marginBottom = `${-gap}px`;
    w.style.opacity = '0';
    setTimeout(done, 310);
  };

  const down = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    const s = { x0: e.clientX, y0: e.clientY, dx: 0, mode: 'idle' as const, long: false, timer: 0 };
    s.timer = window.setTimeout(() => {
      if (st.current?.mode === 'idle') {
        st.current.long = true;
        navigator.vibrate?.(10);
        onLongPress?.();
      }
    }, LONG_PRESS_MS);
    st.current = s;
  };

  const move = (e: React.PointerEvent) => {
    const s = st.current;
    if (!s || s.long) return;
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    if (s.mode === 'idle') {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      clearTimeout(s.timer);
      s.mode = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (s.mode === 'h') (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    if (s.mode !== 'h') return;
    // 沒有對應動作的方向加阻尼
    let x = dx;
    if ((x > 0 && !onEdit) || (x < 0 && !onDelete)) x = x * 0.15;
    else if (Math.abs(x) > THRESHOLD) x = Math.sign(x) * (THRESHOLD + (Math.abs(x) - THRESHOLD) * 0.35);
    s.dx = x;
    set(x);
  };

  const up = () => {
    const s = st.current;
    st.current = null;
    if (!s) return;
    clearTimeout(s.timer);
    if (s.long) return;
    if (s.mode === 'idle') { onTap?.(); return; }
    if (s.mode !== 'h') return;
    if (s.dx <= -THRESHOLD && onDelete) {
      set(-(ref.current?.offsetWidth ?? 400), true);
      if (collapse) setTimeout(() => collapseThen(onDelete), 180);
      else setTimeout(() => { onDelete(); set(0); }, 200);
    } else if (s.dx >= THRESHOLD && onEdit) {
      set(0, true);
      onEdit();
    } else {
      set(0, true);
    }
  };

  return (
    <div className={flat ? 'swipe flat' : 'swipe'} ref={wrap}>
      {onEdit && <div className="swipe-action left" aria-hidden="true"><Icon name="edit" />編輯</div>}
      {onDelete && <div className={`swipe-action right${action ? ' neutral' : ''}`} aria-hidden="true">{action?.label ?? '刪除'}<Icon name={action?.icon ?? 'trash'} /></div>}
      <div ref={ref} className="swipe-content" onPointerDown={down} onPointerMove={move} onPointerUp={up}
        onPointerCancel={() => { if (st.current) clearTimeout(st.current.timer); st.current = null; set(0, true); }}
        onContextMenu={(e) => { if (onLongPress) { e.preventDefault(); onLongPress(); } }}
        role="button" tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onTap?.();
          if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) onDelete();
        }}>
        {children}
      </div>
    </div>
  );
}

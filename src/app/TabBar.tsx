/**
 * Aster 底部靈動島（Liquid Glass 膠囊導覽列）
 * - 高透光玻璃膠囊；目前分頁以「玻璃透鏡」標示，切換分頁時透鏡彈簧滑過去；手指按住導覽列左右滑動，透鏡會跟著手指，放開後前往該分頁
 * - 中央按鈕與膠囊等高、圖示置中：
 *   - 主頁（/ 或 /ledger）：「＋」短按新增記帳，長按（0.35s）直接開啟 AI 語音記帳
 *   - 其他頁面：Logo，點擊回到今日記帳
 *   - 有待確認電子發票或未讀提醒時，右上角出現小光點
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { makeSpring, projectEnd, stepSpring } from '@/domain/spring';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icon, Logo, type IconName } from '@/ui/Icon';
import { holdGuard, openVoice, releaseVoice } from '@/services/voice';
import { useUI } from '@/stores/ui';
import { useUnreadCount } from '@/features/home/RemindersSheet';
import { useInboxCount } from '@/services/inbox';

const LEFT: { to: string; icon: IconName; label: string }[] = [
  { to: '/accounts', icon: 'wallet', label: '帳戶' },
  { to: '/plan', icon: 'folder', label: '專案' },
];
const RIGHT: { to: string; icon: IconName; label: string }[] = [
  { to: '/reports', icon: 'chart', label: '報表' },
  { to: '/settings', icon: 'sliders', label: '設定' },
];

/** 屬於「記帳」區的路徑（中央按鈕顯示＋） */
export function isLedgerPath(pathname: string) {
  return pathname === '/' || pathname === '/add' || pathname.startsWith('/ledger');
}

const HOLD_MS = 350;
const HOME = '/'; // 滑動選取時，中間首頁按鈕的代號

export function TabBar({ hidden = false }: { hidden?: boolean } = {}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const openAdd = useUI((s) => s.openAdd);
  const plusMode = isLedgerPath(pathname);
  const [pressing, setPressing] = useState(false);
  const timer = useRef(0);
  const held = useRef(false);

  // ── 玻璃透鏡：用彈簧物理推動（跟著手指、依速度滑行），不是 CSS 動畫 ──
  const capRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLSpanElement>(null);
  const tabEls = useRef(new Map<string, HTMLElement>());
  const activeTo = [...LEFT, ...RIGHT].find((t) => pathname === t.to || pathname.startsWith(`${t.to}/`))?.to ?? null;
  const [scrubTo, setScrubTo] = useState<string | null>(null);
  const [lensShown, setLensShown] = useState(false);
  const shownTo = scrubTo === HOME ? null : (scrubTo ?? activeTo); // 滑到中間首頁時透鏡淡出，由圓珠自己發光
  const phys = useRef({ x: makeSpring(), w: makeSpring(60), lift: makeSpring(1), raf: 0, last: 0, dragging: false, placed: false });

  const rectOf = (to: string) => {
    const cap = capRef.current;
    const el = tabEls.current.get(to);
    if (!cap || !el) return null;
    const c = cap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - c.left, w: r.width, cx: r.left + r.width / 2 };
  };
  const paint = () => {
    const el = lensRef.current;
    if (!el) return;
    const P = phys.current;
    const speed = P.x.v; // px/s：越快越被拉長、略微壓扁（液態玻璃的黏稠感）
    const stretch = 1 + Math.min(Math.abs(speed) / 4200, 0.10);
    const squash = 1 - Math.min(Math.abs(speed) / 12000, 0.03);
    el.style.width = `${P.w.p}px`;
    el.style.transform = `translate3d(${P.x.p}px,0,0) scale(${(P.lift.p * stretch).toFixed(3)},${(P.lift.p * squash).toFixed(3)})`;
  };
  const tick = (now: number) => {
    const P = phys.current;
    const dt = (now - P.last) / 1000;
    P.last = now;
    // 手指拖曳時彈簧較硬（緊跟著手）；放開後較柔、臨界阻尼（滑過去不彈跳）
    const om = P.dragging ? 42 : 11;
    const m1 = stepSpring(P.x, om, 1, dt);
    const m2 = stepSpring(P.w, om, 1, dt);
    const m3 = stepSpring(P.lift, 22, 0.8, dt);
    paint();
    P.raf = m1 || m2 || m3 ? requestAnimationFrame(tick) : 0;
  };
  const kick = () => {
    const P = phys.current;
    if (!P.raf) { P.last = performance.now(); P.raf = requestAnimationFrame(tick); }
  };
  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  /** 設定透鏡目標位置；instant＝直接放到定位（第一次量測、透鏡隱藏時換位置） */
  const aim = (x: number, w: number, instant = false) => {
    const P = phys.current;
    P.x.t = x; P.w.t = w;
    if (instant || reduceMotion() || !P.placed) { P.x.p = x; P.w.p = w; P.x.v = 0; P.w.v = 0; P.placed = true; paint(); }
    else kick();
  };

  // 目前分頁改變（點選、返回、程式導覽）：透鏡滑到新分頁；沒有對應分頁（首頁）就淡出
  useLayoutEffect(() => {
    if (scrubTo) return;
    const r = activeTo ? rectOf(activeTo) : null;
    if (!r) { setLensShown(false); return; }
    // 透鏡原本是隱藏的：先瞬間放到新位置再淡入，不要從舊位置飛過來
    aim(r.x - 2, r.w + 4, !lensShown);
    setLensShown(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTo, scrubTo]);
  // 視窗或膠囊大小改變（旋轉、字級）時重新對位
  useLayoutEffect(() => {
    const cap = capRef.current;
    if (!cap) return;
    // ResizeObserver 一開始觀察就會先通知一次（大小沒變）：只在寬度真的變了才重新對位，否則換分頁時透鏡會瞬間跳過去
    let lastW = cap.getBoundingClientRect().width;
    const ro = new ResizeObserver(() => {
      const w = cap.getBoundingClientRect().width;
      if (Math.abs(w - lastW) < 0.5) return;
      lastW = w;
      const r = shownTo ? rectOf(shownTo) : null;
      if (r && !phys.current.dragging) aim(r.x - 2, r.w + 4, true);
    });
    ro.observe(cap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownTo]);
  // 卸載（含開發模式 StrictMode 的模擬卸載）時停掉動畫迴圈，並把 raf 歸零，否則之後 kick() 會以為迴圈還在跑而永遠不再啟動
  useEffect(() => () => { cancelAnimationFrame(phys.current.raf); phys.current.raf = 0; }, []);

  // ── 手指在導覽列上滑動：透鏡跟著手指（帶慣性），放開時依速度決定停在哪個分頁 ──
  const scrub = useRef<{ x: number; moved: boolean; id: number; lastX: number; lastT: number; v: number } | null>(null);
  const swallowClick = useRef(false);
  const allTargets = () => [...tabEls.current.keys()];
  const nearestTo = (clientX: number) => {
    let best: string | null = null;
    let dist = Infinity;
    for (const to of allTargets()) {
      const r = rectOf(to);
      if (r && Math.abs(clientX - r.cx) < dist) { dist = Math.abs(clientX - r.cx); best = to; }
    }
    return best;
  };
  const onCapDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('.tab-center') || !t.closest('.tab')) return;
    scrub.current = { x: e.clientX, moved: false, id: e.pointerId, lastX: e.clientX, lastT: performance.now(), v: 0 };
    phys.current.lift.t = 1.1; // 按住：透鏡微微鼓起
    kick();
  };
  const onCapMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = scrub.current;
    if (!st || st.id !== e.pointerId) return;
    const now = performance.now();
    const dt = now - st.lastT;
    if (dt > 0) st.v = 0.75 * st.v + 0.25 * (((e.clientX - st.lastX) / dt) * 1000); // px/s（指數平滑）
    st.lastX = e.clientX; st.lastT = now;
    if (!st.moved && Math.abs(e.clientX - st.x) > 8) {
      st.moved = true;
      phys.current.dragging = true;
      try { capRef.current?.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    }
    if (!st.moved) return;
    // 透鏡中心跟著手指，限制在最左與最右分頁之間；寬度取最近分頁的寬度
    const near = nearestTo(e.clientX);
    const nr = near ? rectOf(near) : null;
    const cap = capRef.current?.getBoundingClientRect();
    if (!nr || !cap) return;
    const rs = allTargets().map((to) => rectOf(to)!).filter(Boolean);
    const lo = Math.min(...rs.map((r) => r.cx)), hi = Math.max(...rs.map((r) => r.cx));
    const cx = Math.min(hi, Math.max(lo, e.clientX));
    const w = near === HOME ? nr.w : nr.w + 4;
    aim(cx - cap.left - w / 2, w);
    if (near && near !== scrubTo) { navigator.vibrate?.(8); setScrubTo(near); }
  };
  const finishScrub = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const st = scrub.current;
    scrub.current = null;
    phys.current.dragging = false;
    phys.current.lift.t = 1;
    kick();
    if (!st || st.id !== e.pointerId) return;
    if (!st.moved) return;
    swallowClick.current = true;
    window.setTimeout(() => { swallowClick.current = false; }, 60);
    // 慣性：依放開速度往前推一小段，再選最近的分頁
    const to = cancelled ? activeTo : nearestTo(projectEnd(e.clientX, st.v));
    setScrubTo(null);
    if (!to) return;
    if (to === HOME) { if (pathname !== HOME) navigate(HOME); setLensShown(false); return; }
    const r = rectOf(to);
    if (r) aim(r.x - 2, r.w + 4); // 從目前位置與速度繼續滑過去
    if (to !== activeTo) navigate(to);
  };
  const onCapUp = (e: React.PointerEvent<HTMLDivElement>) => finishScrub(e, false);
  const onCapCancel = (e: React.PointerEvent<HTMLDivElement>) => finishScrub(e, true);

  // 智慧情境感知：未讀提醒筆數＋待處理收件匣（如發票匯入）
  const unreadCount = useUnreadCount();
  const inboxCount = useInboxCount((s) => s.n);
  const hasAlert = unreadCount > 0 || inboxCount > 0;

  // 長按：在手勢內同步開始語音辨識（iOS 需在使用者手勢內啟動）。短按維持原本功能
  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button > 0) return;
    held.current = false;
    setPressing(true);
    holdGuard(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    timer.current = window.setTimeout(() => {
      held.current = true;
      navigator.vibrate?.(15);
      openVoice(true);
    }, HOLD_MS);
  };

  const onUp = () => {
    window.clearTimeout(timer.current);
    setPressing(false);
    if (held.current) void releaseVoice();
    holdGuard(false);
  };

  const tab = (t: { to: string; icon: IconName; label: string }) => (
    <NavLink key={t.to} to={t.to} className={`tab${scrubTo === t.to ? ' scrub-target' : ''}`} aria-label={t.label}
      ref={(el) => { if (el) tabEls.current.set(t.to, el); else tabEls.current.delete(t.to); }}
      onClick={(e) => { if (swallowClick.current) e.preventDefault(); }}>
      <Icon name={t.icon} size={20} stroke={2.1} />
      <span className="tab-label">{t.label}</span>
    </NavLink>
  );

  return (
    <nav className={`tabbar${hidden ? ' tabbar-off' : ''}`} aria-label="主要導覽" aria-hidden={hidden || undefined}>
      <div className="tabbar-capsule" ref={capRef} onPointerDown={onCapDown} onPointerMove={onCapMove} onPointerUp={onCapUp} onPointerCancel={onCapCancel}>
        {/* 玻璃透鏡（目前分頁的選取泡泡）：位置與大小由彈簧物理直接寫入 style */}
        <span ref={lensRef} className={`dock-lens${lensShown && shownTo ? '' : ' hidden'}`} aria-hidden="true" />

        {/* 左側導覽組 */}
        <div className="tab-group left">{LEFT.map(tab)}</div>

        {/* 中央靈動圓球樞紐 */}
        <div className="tab-center" ref={(el) => { if (el) tabEls.current.set(HOME, el); else tabEls.current.delete(HOME); }}>
          <button
            className={`dynamic-fab${plusMode ? ' mode-plus' : ' mode-logo'}${pressing ? ' pressing' : ''}${scrubTo === HOME ? ' scrub-target' : ''}${hasAlert ? ' has-alert' : ''}`}
            aria-label={plusMode ? '新增記帳（長按語音記帳）' : '回到記帳主頁'}
            onPointerDown={onDown}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onContextMenu={(e) => e.preventDefault()}
            onClick={() => {
              if (held.current) {
                held.current = false;
                return;
              }
              if (plusMode) openAdd();
              else navigate('/');
            }}
          >
            {/* 呼吸擴散波紋 */}
            <span className="fab-aura" aria-hidden="true" />

            {/* 加號圖層 */}
            <span className={`fab-layer${plusMode ? '' : ' off'}`} aria-hidden="true">
              <Icon name="plus" size={28} stroke={2.4} />
            </span>

            {/* Logo 圖層 */}
            <span className={`fab-layer${plusMode ? ' off' : ''}`} aria-hidden="true">
              <Logo />
            </span>

            {/* 智慧情境微光點 */}
            {hasAlert && (
              <span
                className="fab-orbit-dot"
                aria-hidden="true"
                title={`${unreadCount + inboxCount} 則待處理事項`}
              />
            )}
          </button>
        </div>

        {/* 右側導覽組 */}
        <div className="tab-group right">{RIGHT.map(tab)}</div>
      </div>
    </nav>
  );
}

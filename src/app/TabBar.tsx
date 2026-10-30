/**
 * Aster 底部靈動島（Liquid Glass 膠囊導覽列）
 * - 高透光玻璃膠囊；目前分頁以「玻璃透鏡」標示，切換分頁時透鏡彈簧滑過去；手指按住導覽列左右滑動，透鏡會跟著手指，放開後前往該分頁
 * - 中央按鈕與膠囊等高、圖示置中：
 *   - 主頁（/ 或 /ledger）：「＋」短按新增記帳，長按（0.35s）直接開啟 AI 語音記帳
 *   - 其他頁面：Logo，點擊回到今日記帳
 *   - 有待確認電子發票或未讀提醒時，右上角出現小光點
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
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

  // ── 玻璃透鏡：量出目前分頁（或手指所在分頁）的位置與寬度 ──
  const capRef = useRef<HTMLDivElement>(null);
  const tabEls = useRef(new Map<string, HTMLAnchorElement>());
  const activeTo = [...LEFT, ...RIGHT].find((t) => pathname === t.to || pathname.startsWith(`${t.to}/`))?.to ?? null;
  const [scrubTo, setScrubTo] = useState<string | null>(null);
  const [lifted, setLifted] = useState(false);
  const [lens, setLens] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);
  const shownTo = scrubTo === HOME ? null : (scrubTo ?? activeTo); // 滑到中間首頁時透鏡淡出，由圓珠自己發光

  const measure = useCallback(() => {
    const cap = capRef.current;
    const el = shownTo ? tabEls.current.get(shownTo) : undefined;
    if (!cap || !el) return;
    const c = cap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setLens({ x: Math.round(r.left - c.left - 2), w: Math.round(r.width + 4) });
  }, [shownTo]);
  useLayoutEffect(() => {
    measure();
    const cap = capRef.current;
    if (!cap) return;
    const ro = new ResizeObserver(measure);
    ro.observe(cap);
    return () => ro.disconnect();
  }, [measure]);
  useLayoutEffect(() => { const id = requestAnimationFrame(() => setReady(true)); return () => cancelAnimationFrame(id); }, []);

  // ── 手指在導覽列上滑動：透鏡跟著手指，放開後前往該分頁 ──
  const scrub = useRef<{ x: number; moved: boolean; id: number } | null>(null);
  const swallowClick = useRef(false);
  const nearestTab = (clientX: number) => {
    let best: string | null = null;
    let dist = Infinity;
    for (const [to, el] of tabEls.current) {
      const r = el.getBoundingClientRect();
      const d = Math.abs(clientX - (r.left + r.width / 2));
      if (d < dist) { dist = d; best = to; }
    }
    return best;
  };
  const onCapDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.tab-center')) return;
    if (!(e.target as HTMLElement).closest('.tab')) return;
    scrub.current = { x: e.clientX, moved: false, id: e.pointerId };
    setLifted(true);
  };
  const onCapMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = scrub.current;
    if (!st || st.id !== e.pointerId) return;
    if (!st.moved && Math.abs(e.clientX - st.x) > 8) {
      st.moved = true;
      try { capRef.current?.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    }
    if (st.moved) {
      const to = nearestTab(e.clientX);
      if (to && to !== scrubTo) { navigator.vibrate?.(8); setScrubTo(to); }
    }
  };
  const onCapUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = scrub.current;
    scrub.current = null;
    setLifted(false);
    if (!st || st.id !== e.pointerId) return;
    if (st.moved) {
      swallowClick.current = true;
      window.setTimeout(() => { swallowClick.current = false; }, 60);
      const to = scrubTo ?? nearestTab(e.clientX);
      setScrubTo(null);
      if (to === HOME) { if (pathname !== HOME) navigate(HOME); }
      else if (to && to !== activeTo) navigate(to);
    }
  };
  const onCapCancel = () => { scrub.current = null; setLifted(false); setScrubTo(null); };

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
        {/* 玻璃透鏡（目前分頁的選取泡泡） */}
        <span
          className={`dock-lens${shownTo && lens ? '' : ' hidden'}${ready ? '' : ' no-anim'}${lifted ? ' lifted' : ''}${scrubTo ? ' scrub' : ''}`}
          style={{ ['--lens-x' as string]: `${lens?.x ?? 0}px`, ['--lens-w' as string]: `${lens?.w ?? 60}px` }}
          aria-hidden="true"
        />

        {/* 左側導覽組 */}
        <div className="tab-group left">{LEFT.map(tab)}</div>

        {/* 中央靈動圓球樞紐 */}
        <div className="tab-center" ref={(el) => { if (el) tabEls.current.set(HOME, el as unknown as HTMLAnchorElement); else tabEls.current.delete(HOME); }}>
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

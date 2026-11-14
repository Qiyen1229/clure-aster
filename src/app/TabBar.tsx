/**
 * Aster 底部靈動島（Liquid Glass 膠囊導覽列）
 * - 高透光玻璃膠囊；目前分頁以「玻璃透鏡」標示：手指一按下透鏡就 Q 彈地彈到該分頁，按住左右滑動會跟著手指，放開後前往；
 *   放開後的彈簧軌跡預先算好交給合成器播放（WAAPI），換頁掛載再重也不掉幀
 * - 中央按鈕與膠囊等高、圖示置中：
 *   - 主頁（/ 或 /ledger）：「＋」短按新增記帳，長按（0.35s）直接開啟語音記帳
 *   - 其他頁面：品牌花體 A 標記，點擊回到今日記帳
 *   - 任何頁面往上滑：叫出 AI 對話（唯一全局入口）。對話會知道你正在看哪個畫面（「📍 目前畫面」標籤，可一鍵取消），
 *     所以停在投資頁、帳戶頁或報表時都能直接對眼前的東西下指令；一切都是手動觸發，不會自動呼叫 AI
 *   - 有待確認電子發票或未讀提醒時，右上角出現小光點
 */
import { startTransition, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { makeSpring, projectEnd, sampleSpring, stepSpring, trackAt, type SpringTrack } from '@/domain/spring';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '@/ui/Icon';
import { holdGuard } from '@/services/voice';
import { haptic } from '@/services/haptics';
import { markDockNav } from './navSource';
import { useUI } from '@/stores/ui';
import { useUnreadCount } from '@/features/home/RemindersSheet';
import { useInboxTotal } from '@/services/inboxCount';
import { useChat } from '@/features/home/aiChatStore';

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

const SWIPE_UP_PX = 34; // 往上滑超過這個距離＝叫出 AI
const HOME = '/'; // 滑動選取時，中間首頁按鈕的代號

export function TabBar({ hidden = false }: { hidden?: boolean } = {}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const openAdd = useUI((s) => s.openAdd);
  const plusMode = isLedgerPath(pathname);
  const [pressing, setPressing] = useState(false);
  const [aiHold, setAiHold] = useState(false);
  const timer = useRef(0);
  const held = useRef(false);
  /** 這次長按觸發的是語音還是 AI（放開時只有語音需要收尾） */
  const heldKind = useRef<'voice' | 'ai'>('voice');
  const startY = useRef(0);

  // ── 玻璃透鏡 ──
  // 手指拖曳時：rAF 彈簧緊跟手指（只寫 transform，寬度固定，不觸發版面）。
  // 放開、點按、換頁時：先算好整段彈簧軌跡，交給 WAAPI 在合成器播放——就算此時正在掛載新頁面（主執行緒很忙）也不掉幀；
  // 動畫中途被打斷（又按了別的分頁）會從目前位置與速度接續，不會跳。
  const capRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLSpanElement>(null);
  const tabEls = useRef(new Map<string, HTMLElement>());
  const activeTo = [...LEFT, ...RIGHT].find((t) => pathname === t.to || pathname.startsWith(`${t.to}/`))?.to ?? null;
  const [scrubTo, setScrubTo] = useState<string | null>(null);
  const [lensShown, setLensShown] = useState(false);
  const [resumeKey, setResumeKey] = useState(0);
  const shownTo = scrubTo === HOME ? null : (scrubTo ?? activeTo); // 滑到中間首頁時透鏡淡出，由圓珠自己發光
  const phys = useRef({
    x: makeSpring(), raf: 0, last: 0, dragging: false, placed: false,
    anim: null as Animation | null, track: null as SpringTrack | null, t0: 0,
  });

  const rectOf = (to: string) => {
    const cap = capRef.current;
    const el = tabEls.current.get(to);
    if (!cap || !el) return null;
    const c = cap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - c.left, w: r.width, cx: r.left + r.width / 2 };
  };
  /** 依速度算出透鏡的拉長／壓扁（液態玻璃的黏稠感） */
  const lensTransform = (x: number, v: number) => {
    const stretch = 1 + Math.min(Math.abs(v) / 4200, 0.10);
    const squash = 1 - Math.min(Math.abs(v) / 12000, 0.03);
    return `translate3d(${x.toFixed(2)}px,0,0) scale(${stretch.toFixed(3)},${squash.toFixed(3)})`;
  };
  const paint = () => {
    const el = lensRef.current;
    if (el) el.style.transform = lensTransform(phys.current.x.p, phys.current.x.v);
  };
  /** 目前實際位置與速度（可能正由 WAAPI 在播放） */
  const lensNow = () => {
    const P = phys.current;
    return P.track ? trackAt(P.track, (performance.now() - P.t0) / 1000) : { p: P.x.p, v: P.x.v };
  };
  /** 停掉進行中的 WAAPI 動畫，並把目前狀態寫回，之後可以接續 */
  const freeze = () => {
    const P = phys.current;
    if (P.anim) {
      const s = lensNow();
      P.x.p = s.p; P.x.v = s.v; P.x.t = s.p;
      P.anim.onfinish = null;
      P.anim.cancel();
      P.anim = null; P.track = null;
      paint();
    }
  };
  const stopRaf = () => { cancelAnimationFrame(phys.current.raf); phys.current.raf = 0; };
  const tick = (now: number) => {
    const P = phys.current;
    const rawDt = (now - P.last) / 1000;
    const dt = Math.max(0, Math.min(rawDt, 0.05)); // 限制 dt 上限（最多 50ms），防止背景喚醒後時間差過大導致彈簧數值發散
    P.last = now;
    const moving = stepSpring(P.x, 42, 1, dt); // 手指拖曳：硬彈簧，緊跟著手
    paint();
    P.raf = moving ? requestAnimationFrame(tick) : 0;
  };
  const kick = () => {
    const P = phys.current;
    if (!P.raf) { P.last = performance.now(); P.raf = requestAnimationFrame(tick); }
  };
  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  /** 設定透鏡目標位置；instant＝直接放到定位（第一次量測、透鏡隱藏時換位置） */
  const aim = (x: number, instant = false) => {
    const P = phys.current;
    const el = lensRef.current;
    if (instant || reduceMotion() || !P.placed) {
      freeze(); stopRaf();
      P.x.p = x; P.x.t = x; P.x.v = 0; P.placed = true; paint();
      return;
    }
    if (P.dragging) { P.x.t = x; kick(); return; }
    freeze(); stopRaf();
    if (!el || typeof el.animate !== 'function') { P.x.t = x; kick(); return; }
    // Q 彈：欠阻尼（ζ 0.6）會輕輕過衝再回來
    const track = sampleSpring(P.x.p, x, P.x.v, 16, 0.6, 1.2, 60);
    if (track.pos.length < 3) { P.x.p = x; P.x.t = x; P.x.v = 0; paint(); return; }
    const frames = track.pos.map((p, i) => ({ transform: lensTransform(p, track.vel[i]) }));
    P.track = track; P.t0 = performance.now();
    const anim = el.animate(frames, { duration: track.duration * 1000, easing: 'linear', fill: 'forwards' });
    P.anim = anim;
    anim.onfinish = () => {
      P.x.p = x; P.x.t = x; P.x.v = 0;
      P.anim = null; P.track = null;
      paint();
      anim.cancel();
    };
  };
  /** 透鏡寬度跟著分頁按鈕（固定值，位移時不改寬度，不觸發版面） */
  const sizeLens = () => {
    const el = lensRef.current;
    const first = tabEls.current.get(LEFT[0].to);
    if (el && first) el.style.width = `${first.getBoundingClientRect().width + 4}px`;
  };

  // 目前分頁改變（點選、返回、程式導覽，或背景喚醒重建導覽列）：透鏡彈到新分頁；沒有對應分頁（首頁）就淡出
  useLayoutEffect(() => {
    if (scrubTo) return;
    const r = activeTo ? rectOf(activeTo) : null;
    if (!r) { setLensShown(false); return; }
    const P = phys.current;
    if (P.placed && lensShown && Math.abs(P.x.t - (r.x - 2)) < 0.5) return;
    sizeLens();
    // 透鏡原本是隱藏的：先瞬間放到新位置再淡入，不要從舊位置飛過來
    aim(r.x - 2, !lensShown);
    setLensShown(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTo, scrubTo, resumeKey]);
  // 視窗或膠囊大小改變（旋轉、字級、背景喚醒重建）時重新對位
  useLayoutEffect(() => {
    const cap = capRef.current;
    if (!cap) return;
    // ResizeObserver 一開始觀察就會先通知一次（大小沒變）：只在寬度真的變了才重新對位，否則換分頁時透鏡會瞬間跳過去
    let lastW = cap.getBoundingClientRect().width;
    const ro = new ResizeObserver(() => {
      const w = cap.getBoundingClientRect().width;
      if (Math.abs(w - lastW) < 0.5) return;
      lastW = w;
      sizeLens();
      const r = shownTo ? rectOf(shownTo) : null;
      if (r && !phys.current.dragging) aim(r.x - 2, true);
    });
    ro.observe(cap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownTo, resumeKey]);
  // 卸載（含開發模式 StrictMode 的模擬卸載）時停掉動畫迴圈，並把 raf 歸零，否則之後 kick() 會以為迴圈還在跑而永遠不再啟動
  useEffect(() => () => {
    const P = phys.current;
    cancelAnimationFrame(P.raf); P.raf = 0;
    if (P.anim) { P.anim.onfinish = null; P.anim.cancel(); P.anim = null; P.track = null; }
  }, []);

  // ── iOS 背景閒置過久或喚醒時的自動重校準 ──
  // 解決 WebKit 在背景休眠後，固定圖層（position: fixed）偶爾脫離視窗底端、位移至螢幕中央的 Bug
  const navRef = useRef<HTMLElement>(null);
  const hiddenAtRef = useRef(0);
  const resumeTimers = useRef<number[]>([]);
  useEffect(() => {
    const clearResumeTimers = () => {
      while (resumeTimers.current.length) window.clearTimeout(resumeTimers.current.pop());
    };
    const reanchorNav = () => {
      const el = navRef.current;
      if (!el || hidden || document.documentElement.classList.contains('kb-open')) return;
      // 強制 WebKit 卸除並重建 fixed 合成圖層（ScrollingTreeFixedNode）
      el.style.display = 'none';
      void el.offsetHeight;
      el.style.display = '';
      sizeLens();
      const r = shownTo ? rectOf(shownTo) : null;
      if (r && !phys.current.dragging) aim(r.x - 2, true);
    };
    const resetGestures = () => {
      scrub.current = null;
      held.current = false;
      setPressing(false);
      setAiHold(false);
      window.clearTimeout(timer.current);
      const P = phys.current;
      P.dragging = false;
      freeze();
      stopRaf();
    };
    const onHide = () => {
      hiddenAtRef.current = Date.now();
      clearResumeTimers();
      resetGestures();
    };
    const onResume = () => {
      if (document.visibilityState === 'hidden') {
        onHide();
        return;
      }

      clearResumeTimers();
      resetGestures();

      if (hiddenAtRef.current > 0) {
        hiddenAtRef.current = 0;
        phys.current.placed = false;
        setResumeKey((k) => k + 1);
      }

      reanchorNav();
      resumeTimers.current.push(
        window.setTimeout(reanchorNav, 100),
        window.setTimeout(reanchorNav, 360),
      );
    };
    const onViewportResize = () => {
      if (hidden || document.documentElement.classList.contains('kb-open')) return;
      reanchorNav();
    };
    const onViewportScroll = () => {
      const el = navRef.current;
      if (!el || hidden || document.documentElement.classList.contains('kb-open')) return;
      if (Math.abs(window.innerHeight - el.getBoundingClientRect().bottom) > 2) {
        reanchorNav();
      }
    };

    const vv = window.visualViewport;
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('focus', onResume);
    window.addEventListener('resize', onViewportResize);
    vv?.addEventListener('resize', onViewportResize);
    vv?.addEventListener('scroll', onViewportScroll);
    return () => {
      clearResumeTimers();
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onResume);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('resize', onViewportResize);
      vv?.removeEventListener('resize', onViewportResize);
      vv?.removeEventListener('scroll', onViewportScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownTo, hidden]);

  // ── 手指在導覽列上：一按下透鏡就彈到那個分頁（Apple 的做法），按住左右滑動會跟著手指（帶慣性），放開才前往 ──
  const scrub = useRef<{ x: number; moved: boolean; id: number; lastX: number; lastT: number; v: number; to: string } | null>(null);
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
  const lift = (on: boolean) => { if (lensRef.current) lensRef.current.dataset.lift = on ? '1' : ''; }; // 按住：透鏡鼓起（CSS 彈簧，合成器執行）
  const onCapDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const tabEl = t.closest('.tab') as HTMLElement | null;
    if (t.closest('.tab-center') || !tabEl?.dataset.to) return;
    const to = tabEl.dataset.to;
    scrub.current = { x: e.clientX, moved: false, id: e.pointerId, lastX: e.clientX, lastT: performance.now(), v: 0, to };
    lift(true);
    // 不等手指移動：按下的瞬間透鏡就彈到這個分頁
    const r = rectOf(to);
    if (r) {
      sizeLens();
      if (to !== shownTo) haptic('selection');
      aim(r.x - 2, !lensShown);
      setLensShown(true);
      setScrubTo(to);
    }
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
      freeze(); stopRaf(); // 接手：從目前位置與速度開始跟手
      phys.current.dragging = true;
      try { capRef.current?.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    }
    if (!st.moved) return;
    // 透鏡中心跟著手指，限制在最左與最右分頁之間
    const near = nearestTo(e.clientX);
    const nr = near ? rectOf(near) : null;
    const cap = capRef.current?.getBoundingClientRect();
    if (!nr || !cap) return;
    const rs = allTargets().map((to) => rectOf(to)!).filter(Boolean);
    const lo = Math.min(...rs.map((r) => r.cx)), hi = Math.max(...rs.map((r) => r.cx));
    const cx = Math.min(hi, Math.max(lo, e.clientX));
    // 直接寫進 transform（不經彈簧、不等下一幀）：透鏡與手指零延遲，跟手程度取決於螢幕更新率（120Hz 機型就是 120Hz）
    const P = phys.current;
    P.x.p = P.x.t = cx - cap.left - (lensRef.current?.offsetWidth ?? 60) / 2;
    P.x.v = st.v;
    paint();
    if (near && near !== scrubTo) { haptic('selection'); setScrubTo(near); }
  };
  const finishScrub = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const st = scrub.current;
    scrub.current = null;
    lift(false);
    if (!st || st.id !== e.pointerId) return;
    const P = phys.current;
    P.dragging = false;
    stopRaf();
    // 放開後的去向：取消＝回原分頁；拖曳＝依放開速度往前推一小段再選最近的；點按＝按下的那個
    const to = cancelled ? activeTo : st.moved ? nearestTo(projectEnd(e.clientX, st.v)) : st.to;
    swallowClick.current = !cancelled;
    window.setTimeout(() => { swallowClick.current = false; }, 80);
    setScrubTo(null);
    const r = to && to !== HOME ? rectOf(to) : null;
    if (r) {
      if (st.moved || cancelled) aim(r.x - 2); // 拖曳或取消才重新啟動彈簧；單純點按已在 onCapDown 起飛
    } else setLensShown(false);
    if (!to || cancelled) return;
    if (to === HOME) {
      if (pathname !== HOME) startTransition(() => { markDockNav(); navigate(HOME); });
      return;
    }
    if (to !== activeTo) startTransition(() => { markDockNav(); navigate(to); });
  };
  const onCapUp = (e: React.PointerEvent<HTMLDivElement>) => finishScrub(e, false);
  const onCapCancel = (e: React.PointerEvent<HTMLDivElement>) => finishScrub(e, true);

  // 智慧情境感知：未讀提醒筆數＋待處理收件匣（如發票匯入）
  const unreadCount = useUnreadCount();
  const inboxCount = useInboxTotal();
  const hasAlert = unreadCount > 0 || inboxCount > 0;

  /** 叫出 AI 對話（僅限中央按鈕往上滑觸發） */
  const openAi = () => {
    haptic('medium');
    setAiHold(true);
    window.setTimeout(() => setAiHold(false), 500);
    useChat.getState().setOpen(true);
  };

  // 按住往上滑在任何頁面叫出 AI；短按維持原本功能（語音記帳改由首頁右下角獨立按鈕同步觸發）
  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button > 0) return;
    held.current = false;
    startY.current = e.clientY;
    setPressing(true);
    holdGuard(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };

  const onMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (held.current || !pressing) return;
    const up = startY.current - e.clientY;
    if (up > SWIPE_UP_PX) {
      held.current = true;
      heldKind.current = 'ai';
      openAi();
    }
  };

  const onUp = () => {
    window.clearTimeout(timer.current);
    setPressing(false);
    holdGuard(false);
  };

  const tab = (t: { to: string; icon: IconName; label: string }) => (
    <NavLink key={t.to} to={t.to} data-to={t.to} className={`tab${scrubTo === t.to ? ' scrub-target' : ''}`} aria-label={t.label}
      ref={(el) => { if (el) tabEls.current.set(t.to, el); else tabEls.current.delete(t.to); }}
      onClick={(e) => { if (swallowClick.current) e.preventDefault(); else markDockNav(); }}>
      <Icon name={t.icon} size={20} stroke={2.1} />
      <span className="tab-label">{t.label}</span>
    </NavLink>
  );

  return (
    <nav key={resumeKey} ref={navRef} className={`tabbar${hidden ? ' tabbar-off' : ''}`} aria-label="主要導覽" aria-hidden={hidden || undefined}>
      <div className="tabbar-capsule" ref={capRef} onPointerDown={onCapDown} onPointerMove={onCapMove} onPointerUp={onCapUp} onPointerCancel={onCapCancel}>
        {/* 玻璃透鏡（目前分頁的選取泡泡）：位置與大小由彈簧物理直接寫入 style */}
        <span ref={lensRef} className={`dock-lens${lensShown && shownTo ? '' : ' hidden'}`} aria-hidden="true"><span className="dock-lens-in" /></span>

        {/* 左側導覽組 */}
        <div className="tab-group left">{LEFT.map(tab)}</div>

        {/* 中央靈動圓球樞紐 */}
        <div className="tab-center" ref={(el) => { if (el) tabEls.current.set(HOME, el); else tabEls.current.delete(HOME); }}>
          <button
            className={`dynamic-fab${plusMode ? ' mode-plus' : ' mode-logo'}${pressing ? ' pressing' : ''}${aiHold ? ' ai-hold' : ''}${scrubTo === HOME ? ' scrub-target' : ''}${hasAlert ? ' has-alert' : ''}`}
            aria-label={plusMode ? '新增記帳' : '回到記帳主頁'}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onContextMenu={(e) => e.preventDefault()}
            onClick={() => {
              if (held.current) {
                held.current = false;
                return;
              }
              haptic('light');
              if (plusMode) openAdd();
              else { markDockNav(); navigate('/'); }
            }}
          >
            {/* 呼吸擴散波紋 */}
            <span className="fab-aura" aria-hidden="true" />

            {/* 加號圖層 */}
            <span className={`fab-layer${plusMode ? '' : ' off'}`} aria-hidden="true">
              <Icon name="plus" size={28} stroke={2.4} />
            </span>

            {/* 品牌標記圖層：極簡花體 A，與全 App 圖示同一線條語言 */}
            <span className={`fab-layer${plusMode ? ' off' : ''}`} aria-hidden="true">
              <Icon name="brand" size={26} stroke={2} className="brand" />
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

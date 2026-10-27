/**
 * 底部 Tab Bar：帳戶｜專案（預算）｜〔中央〕｜報表｜設定
 *
 * 中央按鈕狀態判斷：
 *  - 位於「記帳（月曆）」或「帳目明細」頁 → 顯示「＋」（主題色圓框），點擊開啟記帳面板；
 *    長按（0.35 秒）開啟語音記帳並立刻開始聽，放開就完成並直接入帳
 *  - 位於其他頁面 → 顯示 App Logo，點擊回到記帳主頁
 * 兩個圖層同時存在，以 opacity + scale + rotate 交叉淡入淡出，切換流暢不閃爍。
 */
import { useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icon, Logo, type IconName } from '@/ui/Icon';
import { openVoice, releaseVoice } from '@/services/voice';
import { useUI } from '@/stores/ui';

const LEFT: { to: string; icon: IconName; label: string }[] = [
  { to: '/accounts', icon: 'wallet', label: '帳戶' },
  { to: '/plan', icon: 'folder', label: '專案與預算' },
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

export function TabBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const openAdd = useUI((s) => s.openAdd);
  const plusMode = isLedgerPath(pathname);
  const [pressing, setPressing] = useState(false);
  const timer = useRef(0);
  const held = useRef(false);

  // 長按：在手勢內同步開始語音辨識（iOS 只允許在使用者手勢裡啟動）。短按維持原本的「記一筆」
  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!plusMode || e.button > 0) return;
    held.current = false;
    setPressing(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
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
  };

  const tab = (t: { to: string; icon: IconName; label: string }) => (
    <NavLink key={t.to} to={t.to} className="tab" aria-label={t.label}>
      <Icon name={t.icon} size={26} />
    </NavLink>
  );

  return (
    <nav className="tabbar" aria-label="主要導覽">
      <div className="tabbar-inner">
        {LEFT.map(tab)}
        <div className="tab-center">
          <button
            className={`fab${plusMode ? '' : ' is-logo'}${pressing ? ' pressing' : ''}`}
            aria-label={plusMode ? '新增記帳（長按說話記帳）' : '回到記帳'}
            onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={(e) => e.preventDefault()}
            onClick={() => {
              if (held.current) { held.current = false; return; } // 長按放開後瀏覽器仍會送出 click，已經處理過了
              if (plusMode) openAdd(); else navigate('/');
            }}
          >
            <span className={`fab-layer${plusMode ? '' : ' off'}`} aria-hidden="true">
              <Icon name="plus" size={30} stroke={2.2} />
            </span>
            <span className={`fab-layer${plusMode ? ' off' : ''}`} aria-hidden="true">
              <Logo />
            </span>
          </button>
        </div>
        {RIGHT.map(tab)}
      </div>
    </nav>
  );
}

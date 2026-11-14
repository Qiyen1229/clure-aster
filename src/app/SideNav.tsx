/**
 * 電腦版側邊導覽（≥1024px）：品牌、主要分頁、工具捷徑、記一筆／語音／Cilo 常駐底部。
 * 手機版維持底部靈動島，這裡只在寬屏渲染；鍵盤捷徑與 App.tsx 的 useShortcuts 一致。
 */
import { NavLink } from 'react-router-dom';
import { Icon, type IconName } from '@/ui/Icon';
import { useUI } from '@/stores/ui';
import { useInboxTotal } from '@/services/inboxCount';
import { useChat } from '@/features/home/aiChatStore';
import { openVoice } from '@/services/voice';

const MAIN: { to: string; icon: IconName; label: string; end?: boolean }[] = [
  { to: '/', icon: 'calendar', label: '首頁', end: true },
  { to: '/accounts', icon: 'wallet', label: '帳戶' },
  { to: '/plan', icon: 'folder', label: '專案與預算' },
  { to: '/reports', icon: 'chart', label: '報表' },
  { to: '/settings', icon: 'sliders', label: '設定' },
];
const TOOLS: { to: string; icon: IconName; label: string }[] = [
  { to: '/ledger', icon: 'list', label: '帳目' },
  { to: '/search', icon: 'search', label: '搜尋' },
  { to: '/inbox', icon: 'inbox', label: '收件匣' },
];

export function SideNav({ hidden = false }: { hidden?: boolean }) {
  const openAdd = useUI((s) => s.openAdd);
  const inboxCount = useInboxTotal();

  const item = (t: { to: string; icon: IconName; label: string; end?: boolean }) => (
    <NavLink key={t.to} to={t.to} end={t.end}
      className={({ isActive }) => `sidenav-item${isActive ? ' active' : ''}`}>
      <Icon name={t.icon} size={19} stroke={2} />
      <span>{t.label}</span>
      {t.to === '/inbox' && inboxCount > 0 && <b className="sidenav-badge num">{inboxCount > 9 ? '9+' : inboxCount}</b>}
    </NavLink>
  );

  return (
    <nav className={`sidenav${hidden ? ' sidenav-off' : ''}`} aria-label="主要導覽" aria-hidden={hidden || undefined}>
      <NavLink to="/" className="sidenav-brand" aria-label="Aster 首頁">
        <span className="sidenav-brand-mark" aria-hidden="true"><Icon name="brand" size={24} stroke={2} /></span>
        <span className="sidenav-brand-name">Aster</span>
      </NavLink>

      <div className="sidenav-group">
        {MAIN.map(item)}
      </div>
      <div className="sidenav-label">工具</div>
      <div className="sidenav-group">
        {TOOLS.map(item)}
      </div>

      <div className="sidenav-foot">
        <button className="btn sidenav-add" onClick={() => openAdd()}>
          <Icon name="plus" size={18} stroke={2.4} />記一筆
        </button>
        <div className="sidenav-quick">
          <button className="sidenav-quick-btn" onClick={() => openVoice(false)} aria-label="語音記帳" title="語音記帳">
            <Icon name="mic" size={18} />
          </button>
          <button className="sidenav-quick-btn" onClick={() => useChat.getState().setOpen(true)} aria-label="開啟 Cilo" title="Cilo AI 助理">
            <Icon name="sparkles" size={18} />
          </button>
        </div>
        <div className="sidenav-kbd" aria-hidden="true">
          <span><kbd>N</kbd> 記一筆</span>
          <span><kbd>/</kbd> 搜尋</span>
          <span><kbd>1–5</kbd> 分頁</span>
        </div>
      </div>
    </nav>
  );
}
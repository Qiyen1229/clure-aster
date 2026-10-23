/**
 * 底部 Tab Bar：帳戶｜專案（預算）｜〔中央〕｜報表｜設定
 *
 * 中央按鈕狀態判斷：
 *  - 位於「記帳（月曆）」或「帳目明細」頁 → 顯示「＋」（主題色圓框），點擊開啟記帳面板
 *  - 位於其他頁面 → 顯示 App Logo，點擊回到記帳主頁
 * 兩個圖層同時存在，以 opacity + scale + rotate 交叉淡入淡出，切換流暢不閃爍。
 */
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icon, Logo, type IconName } from '@/ui/Icon';
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

export function TabBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const openAdd = useUI((s) => s.openAdd);
  const plusMode = isLedgerPath(pathname);

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
            className={`fab${plusMode ? '' : ' is-logo'}`}
            aria-label={plusMode ? '新增記帳' : '回到記帳'}
            onClick={() => (plusMode ? openAdd() : navigate('/'))}
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

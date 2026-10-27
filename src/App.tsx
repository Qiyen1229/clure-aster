/**
 * App 路由與全域外框。首頁（記帳月曆）直接打包進主程式；其他頁面路由懶載入，縮短首屏時間。
 * 深層連結：/add?type=expense&amount=120&category=food&account=<id>&note=午餐&date=2026-10-10&tags=固定支出&project=日本旅行
 */
import { lazy, Suspense, useEffect, useMemo, useRef } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { TabBar } from './app/TabBar';
import { ActionSheetHost, PrivacyShield, SnackbarHost, UpdatePrompt } from './app/overlays';
import HomePage from './features/home/HomePage';
import { useSettings } from './stores/settings';
import { useUI, type AddMode } from './stores/ui';
import { SkeletonRows } from './ui/controls';
import { LockScreen } from './app/LockScreen';
import { installAutoLock } from './services/lock';
import { useVoice } from './services/voice';

// 記帳面板：第一次打開時才載入，App 閒置時預先下載（不佔首屏）
const loadAddSheet = () => import('./features/add/AddSheet');
const AddSheet = lazy(() => loadAddSheet().then((m) => ({ default: m.AddSheet })));
function AddSheetHost() {
  const used = useUI((s) => s.add.seq > 0);
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const run = () => void loadAddSheet().catch(() => undefined);
    if (w.requestIdleCallback) w.requestIdleCallback(run);
    else setTimeout(run, 1500);
  }, []);
  return used ? <Suspense fallback={null}><AddSheet /></Suspense> : null;
}

const VoiceSheet = lazy(() => import('./features/home/VoiceSheet').then((m) => ({ default: m.VoiceSheet })));
/** 語音彈窗：第一次開啟時才載入畫面程式（引擎在 services/voice，手勢裡就能同步開始辨識） */
function VoiceHost() {
  const used = useRef(false);
  const open = useVoice((s) => s.open);
  if (open) used.current = true;
  return used.current ? <Suspense fallback={null}><VoiceSheet /></Suspense> : null;
}

const LedgerPage = lazy(() => import('./features/ledger/LedgerPage'));
const AccountsPage = lazy(() => import('./features/accounts/AccountsPage'));
const AccountDetailPage = lazy(() => import('./features/accounts/AccountsPage').then((m) => ({ default: m.AccountDetailPage })));
const PlanPage = lazy(() => import('./features/plan/PlanPage'));
const ReportsPage = lazy(() => import('./features/reports/ReportsPage'));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage'));
const CategoriesPage = lazy(() => import('./features/settings/CategoriesPage'));
const TagsPage = lazy(() => import('./features/settings/TagsPage'));
const SearchPage = lazy(() => import('./features/search/SearchPage'));
const Onboarding = lazy(() => import('./features/onboarding/Onboarding'));
const ProjectDetailPage = lazy(() => import('./features/plan/projects').then((m) => ({ default: m.ProjectDetailPage })));
const YearReview = lazy(() => import('./features/reports/YearReview'));
const PrintReport = lazy(() => import('./features/reports/PrintReport'));
const StockDetailPage = lazy(() => import('./features/invest/StockDetailPage'));
const WatchlistPage = lazy(() => import('./features/invest/WatchlistPage'));
const DividendsPage = lazy(() => import('./features/invest/DividendsPage'));
const FxPage = lazy(() => import('./features/settings/FxPage'));
const InvestSettingsPage = lazy(() => import('./features/settings/InvestSettingsPage'));
const SecurityPage = lazy(() => import('./features/settings/SecurityPage'));
const NotificationsPage = lazy(() => import('./features/settings/NotificationsPage'));
const BackupPage = lazy(() => import('./features/settings/BackupPage'));
const ImportPage = lazy(() => import('./features/settings/ImportPage'));
const HealthPage = lazy(() => import('./features/settings/HealthPage'));
const WidgetsPage = lazy(() => import('./features/settings/WidgetsPage'));
const RulesPage = lazy(() => import('./features/settings/RulesPage'));
const InvoicePage = lazy(() => import('./features/settings/InvoicePage'));
const FirePage = lazy(() => import('./features/reports/FirePage'));
const TaxPage = lazy(() => import('./features/reports/TaxPage'));
const CashflowPage = lazy(() => import('./features/reports/CashflowPage'));
const SummaryPage = lazy(() => import('./features/reports/SummaryPage'));
const AdminPage = lazy(() => import('./features/admin/AdminPage'));
const InboxPage = lazy(() => import('./features/inbox/InboxPage'));
const WhatsNewSheet = lazy(() => import('./features/onboarding/Highlights').then((m) => ({ default: m.WhatsNewSheet })));

/** 不顯示底部 Tab Bar 的全螢幕頁面 */
const FULLSCREEN = [/^\/onboarding/, /^\/reports\/review/, /^\/reports\/print/];

const TYPES: AddMode[] = ['expense', 'income', 'transfer', 'receivable', 'payable', 'adjust'];

/**
 * 深層連結 /add：開啟記帳面板並預填，接著把網址換回首頁
 * 參數：type、amount、category、account、note、date、tags（逗號分隔的名稱或 id，不存在會自動建立）、project（名稱或 id）
 */
function AddDeepLink() {
  const [p] = useSearchParams();
  const navigate = useNavigate();
  useEffect(() => {
    (async () => {
      const type = p.get('type') as AddMode | null;
      const date = p.get('date');
      const { db, uid } = await import('./db/schema');
      // 標籤：依名稱或 id 對應，找不到的名稱自動建立
      const tagIds: string[] = [];
      const names = (p.get('tags') ?? p.get('tag') ?? '').split(/[,，、|]/).map((x) => x.trim()).filter(Boolean);
      if (names.length) {
        const all = await db.tags.toArray();
        for (const n of names) {
          const hit = all.find((t) => t.id === n || t.name === n);
          if (hit) { if (!tagIds.includes(hit.id)) tagIds.push(hit.id); continue; }
          const now = Date.now();
          const tag = { id: uid(), name: n, color: '#0A84FF', sort: all.length + tagIds.length, createdAt: now, updatedAt: now };
          await db.tags.add(tag);
          all.push(tag);
          tagIds.push(tag.id);
        }
      }
      const pq = p.get('project')?.trim();
      const project = pq ? (await db.projects.toArray()).find((x) => x.id === pq || x.name === pq) : undefined;
      if (pq && !project) useUI.getState().showSnack({ text: `找不到專案「${pq}」` });
      useUI.getState().openAdd({
        mode: type && TYPES.includes(type) ? type : undefined,
        amount: p.get('amount')?.replace(/[^0-9.+\-*/]/g, '') || undefined,
        categoryId: p.get('category') ?? undefined,
        accountId: p.get('account') ?? undefined,
        note: p.get('note') ?? undefined,
        date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
        tagIds: tagIds.length ? tagIds : undefined,
        projectId: project?.id,
        quickText: p.get('text')?.slice(0, 300) || undefined,
      });
      navigate('/', { replace: true });
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <HomePage />;
}

function useShortcuts() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); navigate('/search'); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || useUI.getState().add.open) return;
      const map: Record<string, () => void> = {
        n: () => useUI.getState().openAdd(),
        '/': () => navigate('/search'),
        '1': () => navigate('/accounts'),
        '2': () => navigate('/plan'),
        '3': () => navigate('/'),
        '4': () => navigate('/reports'),
        '5': () => navigate('/settings'),
        l: () => navigate('/ledger'),
      };
      const fn = map[e.key.toLowerCase()];
      if (fn) { e.preventDefault(); fn(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}

/** Tab 順序（帳戶｜專案｜記帳｜報表｜設定），決定切換分頁時的滑入方向 */
const TAB_ROOTS = ['/accounts', '/plan', '/', '/reports', '/settings'];
function tabIndex(path: string): number {
  if (path === '/' || path.startsWith('/ledger') || path.startsWith('/search')) return 2;
  return TAB_ROOTS.findIndex((r) => r !== '/' && (path === r || path.startsWith(`${r}/`) || path.startsWith(`${r}?`)));
}
const depth = (path: string) => path.split('/').filter(Boolean).length;

/**
 * 頁面轉場方向：
 * - 切換底部分頁：往右邊的分頁 → 從右滑入；往左 → 從左滑入
 * - 進入下一層（例如 設定 → 分類）→ 從右滑入；返回上一層 → 從左滑入
 * - 其他 → 淡入上移
 */
function useNavDirection(pathname: string): 'right' | 'left' | 'up' {
  const prev = useRef(pathname);
  return useMemo(() => {
    const from = prev.current;
    prev.current = pathname;
    if (from === pathname) return 'up';
    const df = depth(from), dt = depth(pathname);
    if (df <= 1 && dt <= 1) {
      const a = tabIndex(from), b = tabIndex(pathname);
      if (a >= 0 && b >= 0 && a !== b) return b > a ? 'right' : 'left';
      return 'up';
    }
    if (dt > df) return 'right';
    if (dt < df) return 'left';
    return 'up';
  }, [pathname]);
}

export default function App() {
  const onboarded = useSettings((s) => s.onboarded);
  const location = useLocation();
  useShortcuts();
  const isOnboarding = location.pathname === '/onboarding';
  const fullscreen = FULLSCREEN.some((r) => r.test(location.pathname));
  const navDir = useNavDirection(location.pathname);

  // 開啟 App 時的補算任務與前景循環（動態載入，不影響首屏）
  useEffect(() => {
    if (!onboarded) return;
    let stop: (() => void) | undefined;
    const t = setTimeout(() => {
      void import('./services/startup').then((m) => { void m.runStartupTasks(); stop = m.startAutoRefresh(); });
    }, 600);
    return () => { clearTimeout(t); stop?.(); };
  }, [onboarded]);
  useEffect(() => installAutoLock(), []);

  if (!onboarded && !isOnboarding) return <Navigate to="/onboarding" replace />;

  return (
    <div className="app" data-nav={navDir}>
      <Suspense fallback={<main className="page"><SkeletonRows n={5} /></main>}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/add" element={<AddDeepLink />} />
          <Route path="/ledger" element={<LedgerPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
          <Route path="/plan" element={<PlanPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/categories" element={<CategoriesPage />} />
          <Route path="/settings/tags" element={<TagsPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/plan/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/reports/review/:year" element={<YearReview />} />
          <Route path="/reports/print" element={<PrintReport />} />
          <Route path="/reports/fire" element={<FirePage />} />
          <Route path="/reports/tax" element={<TaxPage />} />
          <Route path="/reports/cashflow" element={<CashflowPage />} />
          <Route path="/reports/summary" element={<SummaryPage />} />
          <Route path="/invest/stock/:id" element={<StockDetailPage />} />
          <Route path="/invest/watchlist" element={<WatchlistPage />} />
          <Route path="/invest/dividends" element={<DividendsPage />} />
          <Route path="/invest" element={<Navigate to="/accounts?tab=invest" replace />} />
          <Route path="/settings/fx" element={<FxPage />} />
          <Route path="/settings/invest" element={<InvestSettingsPage />} />
          <Route path="/settings/security" element={<SecurityPage />} />
          <Route path="/settings/notifications" element={<NotificationsPage />} />
          <Route path="/settings/backup" element={<BackupPage />} />
          <Route path="/settings/import" element={<ImportPage />} />
          <Route path="/settings/health" element={<HealthPage />} />
          <Route path="/settings/widgets" element={<WidgetsPage />} />
          <Route path="/settings/rules" element={<RulesPage />} />
          <Route path="/settings/invoice" element={<InvoicePage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/admin/*" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {!fullscreen && <TabBar />}
      <AddSheetHost />
      <VoiceHost />
      {onboarded && !fullscreen && <Suspense fallback={null}><WhatsNewSheet /></Suspense>}
      <ActionSheetHost />
      <SnackbarHost />
      <UpdatePrompt />
      <PrivacyShield />
      <LockScreen />
    </div>
  );
}

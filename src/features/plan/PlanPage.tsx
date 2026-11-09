/**
 * 專案與預算（Tab 2）：整合為 3 大主題分頁（預算｜週期與借貸｜專案與資產）。
 * 各主題內提供專屬二級分段控制，清晰獨立呈現各區塊（包含耐用品、借貸、專案、目標等），
 * 並完整保留所有舊網址與通知連結相容（?tab=installment / debt / project / wish / durable）。
 */
import { lazy, Suspense, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Segmented, SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { useScreenDetail } from '@/stores/screenContext';

const BudgetSection = lazy(() => import('./budgets'));
const ProjectSection = lazy(() => import('./projects'));
const RecurringSection = lazy(() => import('./recurring'));
const InstallmentSection = lazy(() => import('./installments'));
const DebtSection = lazy(() => import('./debts'));
const GoalSection = lazy(() => import('./goals'));
const WishlistSection = lazy(() => import('./wishlist'));
const DurableSection = lazy(() => import('./durables'));

const MAIN_TABS = [
  { key: 'budget', label: '預算' },
  { key: 'recurring', label: '週期與借貸' },
  { key: 'assets', label: '專案與資產' },
] as const;
type MainTabKey = (typeof MAIN_TABS)[number]['key'];

const RECURRING_SUBS = [
  { key: 'recurring', label: '週期與分期' },
  { key: 'debt', label: '應收應付' },
] as const;

const ASSETS_SUBS = [
  { key: 'project', label: '專案' },
  { key: 'goal', label: '目標' },
  { key: 'durable', label: '耐用品' },
] as const;

export default function PlanPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? 'budget';

  // 由當前 tab 參數推導主要主題與子分頁
  const { mainTab, subTab } = useMemo(() => {
    if (raw === 'debt') return { mainTab: 'recurring' as MainTabKey, subTab: 'debt' };
    if (raw === 'recurring' || raw === 'installment') return { mainTab: 'recurring' as MainTabKey, subTab: 'recurring' };
    if (raw === 'durable') return { mainTab: 'assets' as MainTabKey, subTab: 'durable' };
    if (raw === 'goal' || raw === 'wish') return { mainTab: 'assets' as MainTabKey, subTab: 'goal' };
    if (raw === 'project' || raw === 'assets') return { mainTab: 'assets' as MainTabKey, subTab: 'project' };
    return { mainTab: 'budget' as MainTabKey, subTab: 'budget' };
  }, [raw]);

  // 設定大主題
  const setMain = (m: MainTabKey) => {
    let nextTab = 'budget';
    if (m === 'recurring') nextTab = subTab === 'debt' ? 'debt' : 'recurring';
    else if (m === 'assets') nextTab = (subTab === 'durable' || subTab === 'goal' || subTab === 'project') ? subTab : 'project';
    params.set('tab', nextTab);
    setParams(params, { replace: true });
  };

  // 設定子分類
  const setSub = (s: string) => {
    params.set('tab', s);
    setParams(params, { replace: true });
  };

  const currentLabel = mainTab === 'budget'
    ? '預算'
    : mainTab === 'recurring'
      ? (subTab === 'debt' ? '應收應付' : '週期與分期')
      : (subTab === 'durable' ? '耐用品' : subTab === 'goal' ? '目標' : '專案');

  useScreenDetail(mainTab === 'budget' ? null : `專案與預算 → ${currentLabel}`);

  return (
    <main className="page plan-page">
      <h1 className="large-title" style={{ marginTop: 12 }}>專案與預算</h1>

      {/* 頂部一級大分類：預算｜週期與借貸｜專案與資產 */}
      <div style={{ marginBottom: 10 }}>
        <Segmented
          value={mainTab}
          onChange={setMain}
          ariaLabel="規劃主分類"
          options={MAIN_TABS.map((t) => ({ value: t.key, label: t.label }))}
        />
      </div>

      {/* 週期與借貸專屬二級分段 */}
      {mainTab === 'recurring' && (
        <div style={{ marginBottom: 12, padding: '0 4px' }}>
          <Segmented
            value={subTab === 'debt' ? 'debt' : 'recurring'}
            onChange={setSub}
            ariaLabel="週期與借貸分類"
            options={RECURRING_SUBS.map((s) => ({ value: s.key, label: s.label }))}
          />
        </div>
      )}

      {/* 專案與資產專屬二級分段（包含專案、目標、耐用品） */}
      {mainTab === 'assets' && (
        <div style={{ marginBottom: 12, padding: '0 4px' }}>
          <Segmented
            value={subTab === 'durable' ? 'durable' : subTab === 'goal' ? 'goal' : 'project'}
            onChange={setSub}
            ariaLabel="專案與資產分類"
            options={ASSETS_SUBS.map((s) => ({ value: s.key, label: s.label }))}
          />
        </div>
      )}

      <Suspense fallback={<SkeletonRows />}>
        {mainTab === 'budget' && <BudgetSection />}
        {mainTab === 'recurring' && subTab === 'recurring' && <><RecurringSection /><InstallmentSection /></>}
        {mainTab === 'recurring' && subTab === 'debt' && <DebtSection />}
        {mainTab === 'assets' && subTab === 'project' && <ProjectSection />}
        {mainTab === 'assets' && subTab === 'goal' && <><GoalSection /><WishlistSection /></>}
        {mainTab === 'assets' && subTab === 'durable' && <DurableSection />}
      </Suspense>
    </main>
  );
}

/** 區塊標題列：標題＋新增按鈕 */
export function SectionHead({ title, onAdd, addLabel = '新增' }: { title: string; onAdd?: () => void; addLabel?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '14px 4px 8px' }}>
      <h2 style={{ margin: 0, fontSize: '1.08rem' }}>{title}</h2>
      {onAdd && <button className="btn small tinted" onClick={onAdd}><Icon name="plus" size={16} />{addLabel}</button>}
    </div>
  );
}

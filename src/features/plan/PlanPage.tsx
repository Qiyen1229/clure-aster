/**
 * 專案與預算（Tab 2）：整合為 3 大主題分頁（預算｜週期與借貸｜目標與資產）
 * 舊網址 ?tab=installment / ?tab=debt 轉到週期與借貸；?tab=project / ?tab=wish / ?tab=durable 轉到目標與資產，通知與書籤都不會失效。
 */
import { lazy, Suspense } from 'react';
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

const TABS = [
  { key: 'budget', label: '預算' },
  { key: 'recurring', label: '週期與借貸' },
  { key: 'goal', label: '目標與資產' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export default function PlanPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const legacy = (raw === 'installment' || raw === 'debt')
    ? 'recurring'
    : (raw === 'project' || raw === 'wish' || raw === 'durable')
      ? 'goal'
      : raw;
  const tab = (TABS.some((t) => t.key === legacy) ? legacy : 'budget') as TabKey;
  // 預算分頁由它自己提供更詳細的摘要（各預算使用率），這裡只負責其他分頁
  useScreenDetail(tab === 'budget' ? null : `專案與預算 → ${TABS.find((t) => t.key === tab)?.label ?? ''}`);
  const set = (k: TabKey) => { params.set('tab', k); setParams(params, { replace: true }); };

  return (
    <main className="page">
      <h1 className="large-title" style={{ marginTop: 12 }}>專案與預算</h1>
      <div style={{ marginBottom: 12 }}>
        <Segmented
          value={tab}
          onChange={set}
          ariaLabel="規劃分類"
          options={TABS.map((t) => ({ value: t.key, label: t.label }))}
        />
      </div>
      <Suspense fallback={<SkeletonRows />}>
        {tab === 'budget' && <BudgetSection />}
        {tab === 'recurring' && <><RecurringSection /><InstallmentSection /><DebtSection /></>}
        {tab === 'goal' && <><ProjectSection /><GoalSection /><WishlistSection /><DurableSection /></>}
      </Suspense>
    </main>
  );
}

/** 區塊標題列：標題＋新增按鈕 */
export function SectionHead({ title, onAdd, addLabel = '新增' }: { title: string; onAdd?: () => void; addLabel?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '16px 4px 8px' }}>
      <h2 style={{ margin: 0, fontSize: '1.08rem' }}>{title}</h2>
      {onAdd && <button className="btn small tinted" onClick={onAdd}><Icon name="plus" size={16} />{addLabel}</button>}
    </div>
  );
}

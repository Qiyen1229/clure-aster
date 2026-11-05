/**
 * 專案與預算（Tab 2）：預算｜專案｜週期與分期｜應收應付｜目標（含心願冷靜期）｜耐用品
 * 舊網址 ?tab=installment 轉到週期與分期、?tab=wish 轉到目標，通知與書籤都不會失效。
 */
import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SkeletonRows } from '@/ui/controls';
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
  { key: 'budget', label: '預算', icon: '🎯' },
  { key: 'project', label: '專案', icon: '🧳' },
  { key: 'recurring', label: '週期與分期', icon: '🔁' },
  { key: 'debt', label: '應收應付', icon: '🤝' },
  { key: 'goal', label: '目標', icon: '🐷' },
  { key: 'durable', label: '耐用品', icon: '🧰' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export default function PlanPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const legacy = raw === 'installment' ? 'recurring' : raw === 'wish' ? 'goal' : raw;
  const tab = (TABS.some((t) => t.key === legacy) ? legacy : 'budget') as TabKey;
  // 預算分頁由它自己提供更詳細的摘要（各預算使用率），這裡只負責其他分頁
  useScreenDetail(tab === 'budget' ? null : `專案與預算 → ${TABS.find((t) => t.key === tab)?.label ?? ''}`);
  const set = (k: TabKey) => { params.set('tab', k); setParams(params, { replace: true }); };

  return (
    <main className="page">
      <h1 className="large-title" style={{ marginTop: 12 }}>專案與預算</h1>
      <nav className="sub-row" aria-label="規劃分類" style={{ marginBottom: 8 }}>
        {TABS.map((t) => (
          <button key={t.key} className="pill" aria-pressed={tab === t.key} onClick={() => set(t.key)}>
            <span aria-hidden="true">{t.icon}</span>{t.label}
          </button>
        ))}
      </nav>
      <Suspense fallback={<SkeletonRows />}>
        {tab === 'budget' && <BudgetSection />}
        {tab === 'project' && <ProjectSection />}
        {tab === 'recurring' && <><RecurringSection /><InstallmentSection /></>}
        {tab === 'debt' && <DebtSection />}
        {tab === 'goal' && <><GoalSection /><WishlistSection /></>}
        {tab === 'durable' && <DurableSection />}
      </Suspense>
      <p className="disclaimer"><Icon name="info" size={14} /> 週期帳目與分期會在每次開啟 App 時自動補齊到今天。</p>
    </main>
  );
}

/** 區塊標題列：標題＋新增按鈕 */
export function SectionHead({ title, onAdd, addLabel = '新增' }: { title: string; onAdd?: () => void; addLabel?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '12px 4px 8px' }}>
      <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h2>
      {onAdd && <button className="btn small tinted" onClick={onAdd}><Icon name="plus" size={16} />{addLabel}</button>}
    </div>
  );
}

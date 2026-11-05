/**
 * 對話即介面：把檢視卡直接嵌在對話流裡（財務自由、稅務、現金流、花費）。全部是本機運算與既有的領域引擎，不呼叫 AI。
 * refreshKey 變了（例如計畫剛執行完）就依新資料重算。各卡是獨立的動態載入區塊，沒用到就不下載。
 */
import { lazy, Suspense } from 'react';
import type { ViewSpec } from '@/domain/agent/plan';

const FireView = lazy(() => import('./FireView').then((m) => ({ default: m.FireView })));
const TaxView = lazy(() => import('./TaxView').then((m) => ({ default: m.TaxView })));
const CashflowView = lazy(() => import('./CashflowView').then((m) => ({ default: m.CashflowView })));
const SpendingView = lazy(() => import('./SpendingView').then((m) => ({ default: m.SpendingView })));

export const VIEW_TITLE: Record<ViewSpec['kind'], string> = { fire: '🏝️ 財務自由模擬', tax: '🧾 稅務規劃', cashflow: '🔮 現金流預測', spending: '🥧 花費分析' };

export function ViewBubble({ view, refreshKey }: { view: ViewSpec; refreshKey?: string }) {
  return (
    <section className="view-wrap" aria-label={VIEW_TITLE[view.kind]}>
      <div className="row-title" style={{ marginBottom: 6 }}>{VIEW_TITLE[view.kind]}{refreshKey ? <span className="chip" style={{ marginLeft: 6 }}>已依新資料重算</span> : null}</div>
      <Suspense fallback={<div className="skeleton" style={{ height: 120 }} />}>
        {view.kind === 'fire' && <FireView params={view.params} refreshKey={refreshKey} />}
        {view.kind === 'tax' && <TaxView />}
        {view.kind === 'cashflow' && <CashflowView params={view.params} refreshKey={refreshKey} />}
        {view.kind === 'spending' && <SpendingView params={view.params} refreshKey={refreshKey} />}
      </Suspense>
    </section>
  );
}

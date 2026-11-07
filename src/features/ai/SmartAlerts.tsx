/**
 * 智慧提醒（原本在設定頁，v4.0.1 搬到 AI 助理）：異常與訂閱偵測、預算預警、規則判斷不了時請 AI 查市價。
 * 偵測本身是在這台裝置用規則運算，不計入 AI 額度；沒有登入／沒開 AI 時也能使用。說明文字收在 ⓘ 裡。
 */
import { Hint } from '@/ui/Hint';
import { InsightsResults } from '@/features/insights/InsightsPage';

export function SmartAlerts() {
  return (
    <section className="card" style={{ minWidth: 0 }}>
      <Hint id="ai.smartAlerts" title="🔔 智慧提醒"
        hint="找出沒登記的訂閱、漲價、重複扣款、異常大額、分類暴增。全在這台裝置用規則運算，不計入 AI 額度" />
      <InsightsResults />
    </section>
  );
}

/**
 * 智慧提醒（原本在設定頁，v4.0.1 搬到 AI 助理）：異常與訂閱偵測、預算預警、規則判斷不了時請 AI 查市價。
 * 偵測本身是在這台裝置用規則運算，不計入 AI 額度；沒有登入／沒開 AI 時也能使用。說明文字收在 ⓘ 裡。
 */
import { useNavigate } from 'react-router-dom';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { Switch } from '@/ui/controls';
import { Hint, LabelHint } from '@/ui/Hint';

export function SmartAlerts() {
  const navigate = useNavigate();
  const insights = useSettings((s) => s.insights);
  const ai = useSettings((s) => s.ai);
  const set = useSettings((s) => s.set);
  return (
    <section className="card" style={{ minWidth: 0 }}>
      <Hint id="ai.smartAlerts" title="🔔 智慧提醒"
        hint="平常全部在這台裝置上用規則運算，不計入 AI 額度。系統會在你每新增一筆支出時自動偵測一次（沒有手動重新偵測）。大額但本來就大的項目（買家電、學雜費、買車…）不會提醒；吃飯、超商這類小額支出突然出現大額才會。" />
      <div className="list" style={{ marginTop: 8 }}>
        <div className="field"><LabelHint id="ai.sa.anomaly" label="異常與訂閱偵測" hint="找出沒登記的訂閱、漲價、重複扣款、異常大額、分類暴增" />
          <Switch checked={insights.anomaly} label="異常與訂閱偵測" onChange={(v) => set('insights', { ...insights, anomaly: v })} /></div>
        <div className="field"><LabelHint id="ai.sa.budget" label="預算預警" hint="照目前花法會超支時，提早提醒並告訴你每天最多能花多少" />
          <Switch checked={insights.budgetWarn} label="預算預警" onChange={(v) => set('insights', { ...insights, budgetWarn: v })} /></div>
        {AUTH_ENABLED && insights.anomaly && (
          <div className="field"><LabelHint id="ai.sa.price" label="規則判斷不了時，請 AI 查市價"
            hint={ai?.enabled ? '只在新支出比平常高很多、又查不到行情時才問，每筆只問一次，不計額度；送出的內容可在「AI 設定 → 查看送出過什麼」檢查' : '需要先開啟 AI 功能；沒開時只在金額離譜到極端才提醒'} />
            <Switch checked={insights.aiPrice && !!ai?.enabled} label="請 AI 查市價" onChange={(v) => { if (ai?.enabled) set('insights', { ...insights, aiPrice: v }); }} /></div>
        )}
        {(insights.anomaly || insights.budgetWarn) && (
          <button className="row" onClick={() => navigate('/insights')}><span className="row-main row-title">查看目前的偵測結果</span><span className="accent">›</span></button>
        )}
      </div>
    </section>
  );
}

/**
 * 智慧提醒（原本在設定頁，v4.0.1 搬到 AI 助理）：異常與訂閱偵測、預算預警、規則判斷不了時請 AI 查市價。
 * 偵測本身是在這台裝置用規則運算，不計入 AI 額度；沒有登入／沒開 AI 時也能使用。
 */
import { useNavigate } from 'react-router-dom';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { Switch } from '@/ui/controls';
import { Fold } from '@/ui/Fold';

export function SmartAlerts() {
  const navigate = useNavigate();
  const insights = useSettings((s) => s.insights);
  const ai = useSettings((s) => s.ai);
  const set = useSettings((s) => s.set);
  const rowSub = (t: string) => <span className="row-sub" style={{ display: 'block', whiteSpace: 'normal' }}>{t}</span>;
  return (
    <Fold id="ai.smartAlerts" title="🔔 智慧提醒" desc="異常與訂閱偵測、預算預警（在這台裝置用規則運算，不計入 AI 額度）">
      <div className="list">
        <div className="field"><span className="label" style={{ flex: 1 }}>異常與訂閱偵測{rowSub('找出沒登記的訂閱、漲價、重複扣款、異常大額、分類暴增')}</span>
          <Switch checked={insights.anomaly} label="異常與訂閱偵測" onChange={(v) => set('insights', { ...insights, anomaly: v })} /></div>
        <div className="field"><span className="label" style={{ flex: 1 }}>預算預警{rowSub('照目前花法會超支時，提早提醒並告訴你每天最多能花多少')}</span>
          <Switch checked={insights.budgetWarn} label="預算預警" onChange={(v) => set('insights', { ...insights, budgetWarn: v })} /></div>
        {AUTH_ENABLED && insights.anomaly && (
          <div className="field"><span className="label" style={{ flex: 1 }}>規則判斷不了時，請 AI 查市價{rowSub(ai?.enabled ? '只在新支出比平常高很多、又查不到行情時才問，每筆只問一次，不計額度；送出的內容可在「AI 設定 → 查看送出過什麼」檢查' : '需要先開啟 AI 功能；沒開時只在金額離譜到極端才提醒')}</span>
            <Switch checked={insights.aiPrice && !!ai?.enabled} label="請 AI 查市價" onChange={(v) => { if (ai?.enabled) set('insights', { ...insights, aiPrice: v }); }} /></div>
        )}
        {(insights.anomaly || insights.budgetWarn) && (
          <button className="row" onClick={() => navigate('/insights')}><span className="row-main row-title">查看目前的偵測結果</span><span className="accent">›</span></button>
        )}
      </div>
      <p className="set-note">系統會在你每新增一筆支出時自動偵測一次（沒有手動重新偵測）。大額但本來就大的項目（買家電、學雜費、買車…）不會提醒；吃飯、超商這類小額支出突然出現大額才會。</p>
    </Fold>
  );
}

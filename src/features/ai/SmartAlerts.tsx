/**
 * 智慧提醒：異常與訂閱偵測、預算預警、規則判斷不了時請 AI 查市價。
 * 偵測本機端以規則運算，不計入 AI 額度；完全符合 Aster 原生 iOS 設計規範。
 */
import { useNavigate } from 'react-router-dom';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { InsightsResults } from '@/features/insights/InsightsPage';
import type { AiStatus } from '@/services/ai';

export function SmartAlerts({ aiStatus }: { aiStatus?: AiStatus | null }) {
  const navigate = useNavigate();
  const insights = useSettings((s) => s.insights);
  const ai = useSettings((s) => s.ai);
  const set = useSettings((s) => s.set);

  const dataOn = !!ai?.allowData;

  return (
    <div style={{ minWidth: 0 }}>
      {/* 1. 頂部狀態卡片 */}
      <div className="card glass" style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '4px 0 16px' }}>
        <span
          className="row-icon"
          style={{
            background: '#30D158',
            color: '#fff',
            width: 40,
            height: 40,
            borderRadius: 12,
            display: 'inline-grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          <Icon name="shieldCheck" size={22} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '0.98rem', color: 'var(--text)' }}>本機離線智慧守護</div>
          <div className="muted" style={{ fontSize: '0.82rem', marginTop: 2, lineHeight: 1.4 }}>
            純端運算不耗額度，自動偵測未登記訂閱、異常漲價與預算超支。
          </div>
        </div>
      </div>

      {/* 2. 即時防護開關 */}
      <div className="section-title">即時偵測防護</div>
      <div className="list">
        <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              className="row-icon"
              style={{
                background: '#BF5AF2',
                color: '#fff',
                width: 32,
                height: 32,
                borderRadius: 8,
                display: 'inline-grid',
                placeItems: 'center',
              }}
            >
              <Icon name="repeat" size={17} />
            </span>
            <span className="row-title">消費異常與訂閱偵測</span>
          </div>
          <Switch
            checked={insights.anomaly}
            label="消費異常與訂閱偵測"
            onChange={(v) => set('insights', { ...insights, anomaly: v })}
          />
        </div>
        <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              className="row-icon"
              style={{
                background: '#FF9F0A',
                color: '#fff',
                width: 32,
                height: 32,
                borderRadius: 8,
                display: 'inline-grid',
                placeItems: 'center',
              }}
            >
              <Icon name="target" size={17} />
            </span>
            <span className="row-title">預算進度超支預警</span>
          </div>
          <Switch
            checked={insights.budgetWarn}
            label="預算進度超支預警"
            onChange={(v) => set('insights', { ...insights, budgetWarn: v })}
          />
        </div>
        {AUTH_ENABLED && insights.anomaly && (
          <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span
                className="row-icon"
                style={{
                  background: '#0A84FF',
                  color: '#fff',
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  display: 'inline-grid',
                  placeItems: 'center',
                }}
              >
                <Icon name="sparkles" size={17} />
              </span>
              <span className="row-title">疑難支出請 AI 比對市價</span>
            </div>
            <Switch
              checked={insights.aiPrice && !!ai?.enabled}
              label="請 AI 查市價"
              onChange={(v) => {
                if (ai?.enabled) set('insights', { ...insights, aiPrice: v });
                else navigate('/settings/ai');
              }}
            />
          </div>
        )}
      </div>

      {/* 3. AI 智慧延伸 */}
      {AUTH_ENABLED && (
        <>
          <div className="section-title">AI 智慧分析</div>
          <div className="list">
            {!ai?.enabled ? (
              <button type="button" className="row tap" onClick={() => navigate('/settings/ai')}>
                <span
                  className="row-icon"
                  style={{
                    background: '#17181c',
                    color: '#fff',
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    display: 'inline-grid',
                    placeItems: 'center',
                  }}
                >
                  <Icon name="ai" size={17} />
                </span>
                <span className="row-main">
                  <span className="row-title">AI 對話與進階財務分析</span>
                  <span className="row-sub">目前未啟用 · 點擊前往設定開啟</span>
                </span>
                <Icon name="chevronR" className="row-chev" />
              </button>
            ) : !dataOn ? (
              <button type="button" className="row tap" onClick={() => navigate('/settings/ai')}>
                <span
                  className="row-icon"
                  style={{
                    background: '#FF9F0A',
                    color: '#fff',
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    display: 'inline-grid',
                    placeItems: 'center',
                  }}
                >
                  <Icon name="shieldCheck" size={17} />
                </span>
                <span className="row-main">
                  <span className="row-title">財務數據存取授權</span>
                  <span className="row-sub">問 AI 與財務分析需要允許存取去識別化統計 · 點擊前往授權</span>
                </span>
                <Icon name="chevronR" className="row-chev" />
              </button>
            ) : (
              <button type="button" className="row tap" onClick={() => navigate('/settings/ai')}>
                <span
                  className="row-icon"
                  style={{
                    background: '#30D158',
                    color: '#fff',
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    display: 'inline-grid',
                    placeItems: 'center',
                  }}
                >
                  <Icon name="sparkles" size={17} />
                </span>
                <span className="row-main">
                  <span className="row-title">AI 分析服務運作中</span>
                  <span className="row-sub">
                    {aiStatus
                      ? `今日剩 ${aiStatus.quota.daily.remaining ?? '不限'} 次 · 本週剩 ${aiStatus.quota.weekly.remaining ?? '不限'} 次`
                      : '點擊管理 AI 功能與查看額度點數'}
                  </span>
                </span>
                <Icon name="chevronR" className="row-chev" />
              </button>
            )}
          </div>
        </>
      )}

      {/* 4. 偵測結果 */}
      <InsightsResults />
    </div>
  );
}

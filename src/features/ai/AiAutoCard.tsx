/**
 * 首頁「上週重點」：只有在設定開啟「自動產生」時才會出現，每週最多自動用 1 點額度（services/ai.autoWeeklyInsight）。
 * 可折疊：收合時只剩一行標題，展開才看到重點與建議；折疊狀態記在這台裝置（localStorage，讀寫失敗時預設展開）。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { autoWeeklyInsight } from '@/services/ai';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';

const KEY = 'aster.aiCard.collapsed';
const readCollapsed = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

export function AiAutoCard() {
  const navigate = useNavigate();
  const on = useSettings((s) => !!s.ai?.enabled && !!s.ai?.allowData && !!s.ai?.auto);
  const [r, setR] = useState<Awaited<ReturnType<typeof autoWeeklyInsight>>>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    if (!on) { setR(null); return; }
    let alive = true;
    void autoWeeklyInsight().then((x) => alive && setR(x)).catch(() => undefined);
    return () => { alive = false; };
  }, [on]);
  if (!r) return null;
  const toggle = () => setCollapsed((c) => { try { localStorage.setItem(KEY, c ? '0' : '1'); } catch { /* 忽略 */ } return !c; });
  return (
    <section className={`ai-card${collapsed ? ' collapsed' : ''}`} aria-label="AI 上週重點">
      <button className="ai-card-head" onClick={toggle} aria-expanded={!collapsed}>
        <span aria-hidden="true">✨</span>
        <span className="row-main"><b>{r.label}：</b>{collapsed ? <span className="ai-card-headline-1">{r.value.headline}</span> : r.value.headline}</span>
        <span className="ai-card-chev" aria-hidden="true"><Icon name="chevronD" size={18} /></span>
      </button>
      <div className="ai-card-body">
        <div className="ai-card-body-in">
          {r.value.suggestion && <span className="ai-card-tip">💡 {r.value.suggestion}</span>}
          <button className="ai-card-more" onClick={() => navigate('/reports/summary?unit=week')}>看完整週報 →</button>
        </div>
      </div>
    </section>
  );
}

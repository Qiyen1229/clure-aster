/**
 * 首頁「上週重點」：只有在設定開啟「自動產生」時才會出現，每週最多自動用 1 點額度（services/ai.autoWeeklyInsight）。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { autoWeeklyInsight } from '@/services/ai';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';

export function AiAutoCard() {
  const navigate = useNavigate();
  const on = useSettings((s) => !!s.ai?.enabled && !!s.ai?.allowData && !!s.ai?.auto);
  const [r, setR] = useState<Awaited<ReturnType<typeof autoWeeklyInsight>>>(null);
  useEffect(() => {
    if (!on) { setR(null); return; }
    let alive = true;
    void autoWeeklyInsight().then((x) => alive && setR(x)).catch(() => undefined);
    return () => { alive = false; };
  }, [on]);
  if (!r) return null;
  return (
    <button className="ai-card" onClick={() => navigate('/reports/summary?unit=week')}>
      <span className="ai-card-head">
        <span aria-hidden="true">✨</span>
        <span className="row-main"><b>{r.label}：</b>{r.value.headline}</span>
        <Icon name="chevronR" size={18} />
      </span>
      {r.value.suggestion && <span className="ai-card-tip">💡 {r.value.suggestion}</span>}
    </button>
  );
}

/**
 * 首頁的小提示：有「建議看一下」的偵測結果或預算預警時，一行提示點進 /insights。
 * 只讀快取（不在畫面上算任何東西）；兩個偵測都關閉時完全不顯示。
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { loadSnapshot } from '@/services/insights';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';

export function InsightsBanner() {
  const navigate = useNavigate();
  const cfg = useSettings((s) => s.insights);
  const snap = useLiveQuery(() => loadSnapshot(), []);
  if (!cfg || !(cfg.anomaly || cfg.budgetWarn) || !snap) return null;
  const warn = snap.findings.filter((f) => f.severity === 'warn').length;
  const budget = cfg.budgetWarn ? snap.warnings.length : 0;
  const n = (cfg.anomaly ? warn : 0) + budget;
  if (!n) return null;
  const parts = [budget ? `${budget} 個預算快超支` : '', cfg.anomaly && warn ? `${warn} 項異常` : ''].filter(Boolean).join('、');
  return (
    <button className="insights-banner" onClick={() => navigate('/insights')}>
      <span aria-hidden="true">🔎</span>
      <span className="row-main"><b>{parts}</b>，點開看白話說明</span>
      <Icon name="chevronR" size={18} />
    </button>
  );
}

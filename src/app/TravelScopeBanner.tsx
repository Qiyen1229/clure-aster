/**
 * 旅遊模式範圍提示：帳目明細／搜尋頁顯示「只顯示這次旅程的帳目」，可一鍵切換回一般模式。
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { useSettings } from '@/stores/settings';

export function TravelScopeBanner() {
  const travelId = useSettings((st) => st.travelModeProjectId);
  const project = useLiveQuery(() => (travelId ? db.projects.get(travelId) : undefined), [travelId]);
  if (!travelId || !project) return null;
  return (
    <div className="travel-scope-banner" role="status">
      <span className="travel-mode-chip">旅遊模式</span>
      <span className="travel-scope-text">只顯示「{project.name}」的帳目</span>
      <button
        type="button"
        className="travel-switch-btn"
        onClick={() => useSettings.getState().set('travelModeProjectId', null)}
        aria-label="切換回一般模式"
      >
        切換回一般模式
      </button>
    </div>
  );
}
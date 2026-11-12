/**
 * 旅遊模式首頁頂部看板（TravelHero）：
 * - 純文字無 emoji 的俐落介面
 * - 顯示旅程名稱、天數進度、目前總支出（外幣與折合本幣）
 * - 預算進度條
 * - 快速記一筆旅行開銷、查看專案詳情、切換回一般模式
 */
import { useLiveQuery } from 'dexie-react-hooks';
import type { Project } from '@/db/types';
import { projectStats } from '@/db/repo/plan';
import { eachDay, todayKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';
import { Amount } from '@/ui/controls';

interface TravelHeroProps {
  project: Project;
  onSwitchNormal: () => void;
  onAddTripExpense: () => void;
  onViewProject: () => void;
}

export function TravelHero({ project, onSwitchNormal, onAddTripExpense, onViewProject }: TravelHeroProps) {
  const base = useSettings((s) => s.baseCurrency);
  const stats = useLiveQuery(() => projectStats(project), [project.id]);
  const today = todayKey();

  let dayText = '';
  if (today < project.start) {
    dayText = '旅程即將出發';
  } else if (!project.end || today <= project.end) {
    const passed = eachDay({ start: project.start, end: today }).length;
    if (project.end) {
      const allDays = eachDay({ start: project.start, end: project.end }).length;
      dayText = `第 ${passed} 天 / 共 ${allDays} 天`;
    } else {
      dayText = `第 ${passed} 天`;
    }
  } else {
    dayText = '旅程已結束';
  }

  const spentMinor = stats?.expense ?? 0;
  const budgetMinor = project.budgetMinor;
  const pct = budgetMinor ? Math.round((spentMinor / budgetMinor) * 100) : null;
  const isOver = budgetMinor ? spentMinor > budgetMinor : false;

  return (
    <section className="home-hero travel-hero" aria-label="旅遊模式看板">
      <div className="travel-hero-top">
        <div className="travel-mode-badge-group">
          <span className="travel-mode-chip">旅遊模式</span>
          <span className="travel-hero-project-name">{project.name}</span>
          <span className="travel-hero-day-sub">{dayText}</span>
        </div>
        <button
          type="button"
          className="travel-switch-btn"
          onClick={onSwitchNormal}
          aria-label="切換回一般模式"
        >
          切換回一般模式
        </button>
      </div>

      <div className="travel-hero-main">
        <div className="hero-label">本次旅程總支出</div>
        <div className="hero-amount num">
          <Amount minor={spentMinor} currency={project.currency} tone="none" opts={{ decimals: 0 }} animate />
        </div>
        {project.currency !== base && stats && stats.expenseBase > 0 && (
          <div className="hero-sub num travel-hero-equiv">
            折合&nbsp;<Amount minor={stats.expenseBase} currency={base} tone="none" opts={{ decimals: 0 }} />
          </div>
        )}
      </div>

      {budgetMinor ? (
        <div className="travel-budget-block">
          <div className="travel-budget-row">
            <span className="travel-budget-label">預算進度</span>
            <span className="travel-budget-val num">
              {pct}%（剩餘&nbsp;<Amount minor={Math.max(0, budgetMinor - spentMinor)} currency={project.currency} tone="none" opts={{ decimals: 0 }} />）
            </span>
          </div>
          <div className="bar" style={{ marginTop: 6 }}>
            <i
              style={{
                width: `${Math.min(100, pct || 0)}%`,
                ['--c' as string]: isOver ? 'var(--danger)' : 'var(--accent)',
              }}
            />
          </div>
        </div>
      ) : null}

      <div className="travel-hero-actions">
        <button type="button" className="btn tinted small travel-add-btn" onClick={onAddTripExpense}>
          記一筆旅行開銷
        </button>
        <button type="button" className="btn secondary small" onClick={onViewProject}>
          查看專案詳情
        </button>
      </div>
    </section>
  );
}

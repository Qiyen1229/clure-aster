/**
 * 旅遊模式首頁頂部看板「登機證」（島嶼假期主題）：
 * - 漸層證首：旅程名稱、出發／返程日期、天數進度、切換回一般模式
 * - 撕線＋圓形戳章（倒數／第幾天／已完成）＋條碼裝飾
 * - 目前總支出（外幣與折合本幣）、預算進度、快速記一筆與專案詳情
 */
import { useLiveQuery } from 'dexie-react-hooks';
import type { Project } from '@/db/types';
import { projectStats } from '@/db/repo/plan';
import { eachDay, todayKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';
import { Amount } from '@/ui/controls';

export interface TripDayInfo {
  phase: 'before' | 'during' | 'after';
  /** 出發前＝倒數天數；旅程中＝第幾天；結束後＝總天數 */
  dayNum: number;
  totalDays: number | null;
  label: string;
}

export function tripDayInfo(project: Pick<Project, 'start' | 'end'>, today: string): TripDayInfo {
  if (today < project.start) {
    const until = eachDay({ start: today, end: project.start }).length - 1;
    const totalDays = project.end ? eachDay({ start: project.start, end: project.end }).length : null;
    return { phase: 'before', dayNum: until, totalDays, label: `${until} 天後出發` };
  }
  const passed = eachDay({ start: project.start, end: today }).length;
  if (!project.end || today <= project.end) {
    const totalDays = project.end ? eachDay({ start: project.start, end: project.end }).length : null;
    return {
      phase: 'during',
      dayNum: passed,
      totalDays,
      label: totalDays ? `第 ${passed} 天 / 共 ${totalDays} 天` : `第 ${passed} 天`,
    };
  }
  const totalDays = eachDay({ start: project.start, end: project.end }).length;
  return { phase: 'after', dayNum: totalDays, totalDays, label: '旅程已結束' };
}

const shortDate = (key: string) => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;

interface TravelHeroProps {
  project: Project;
  onSwitchNormal: () => void;
  onAddTripExpense: () => void;
  onViewProject: () => void;
}

export function TravelHero({ project, onSwitchNormal, onAddTripExpense, onViewProject }: TravelHeroProps) {
  const base = useSettings((s) => s.baseCurrency);
  const stats = useLiveQuery(() => projectStats(project), [project.id]);
  const info = tripDayInfo(project, todayKey());

  const spentMinor = stats?.expense ?? 0;
  const budgetMinor = project.budgetMinor;
  const pct = budgetMinor ? Math.round((spentMinor / budgetMinor) * 100) : null;
  const isOver = budgetMinor ? spentMinor > budgetMinor : false;

  const stampLabel = info.phase === 'before' ? '天後出發' : info.phase === 'after' ? '天・已完成' : info.totalDays ? `共 ${info.totalDays} 天` : '旅程進行中';

  return (
    <section className="home-hero travel-pass" aria-label="旅遊模式看板">
      <div className="travel-pass-head">
        <div className="travel-pass-titles">
          <div className="travel-mode-badge-group">
            <span className="travel-mode-chip">旅遊模式</span>
            <span className="travel-hero-day-sub">{info.label}</span>
          </div>
          <button type="button" className="travel-switch-btn" onClick={onSwitchNormal} aria-label="切換回一般模式">
            切換回一般模式
          </button>
        </div>
        <h2 className="travel-pass-name">{project.name}</h2>
        <div className="travel-pass-route">
          <span className="travel-pass-endpoint">
            <i className="travel-pass-dot" aria-hidden="true" />
            <span className="num">{shortDate(project.start)} 出發</span>
          </span>
          <span className="travel-pass-route-line" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M2 21l20-9L2 3v7l14 2-14 2v7z" />
            </svg>
          </span>
          <span className="travel-pass-endpoint">
            <span className="num">{project.end ? `${shortDate(project.end)} 返程` : '返程未定'}</span>
            <i className="travel-pass-dot to" aria-hidden="true" />
          </span>
        </div>
      </div>

      <div className="travel-pass-tear" aria-hidden="true" />

      <div className="travel-pass-body">
        <div className="travel-pass-main">
          <div className="hero-label">本次旅程總支出</div>
          <div className="hero-amount num">
            <Amount minor={spentMinor} currency={project.currency} tone="none" opts={{ decimals: 0 }} animate />
          </div>
          {project.currency !== base && stats && stats.expenseBase > 0 && (
            <div className="hero-sub num travel-hero-equiv">
              折合&nbsp;
              <Amount minor={stats.expenseBase} currency={base} tone="none" opts={{ decimals: 0 }} />
            </div>
          )}
          {budgetMinor ? (
            <div className="travel-budget-block">
              <div className="travel-budget-row">
                <span className="travel-budget-label">預算進度</span>
                <span className="travel-budget-val num">
                  {pct}%（剩餘&nbsp;
                  <Amount minor={Math.max(0, budgetMinor - spentMinor)} currency={project.currency} tone="none" opts={{ decimals: 0 }} />）
                </span>
              </div>
              <div className="bar" style={{ marginTop: 6 }}>
                <i
                  style={{
                    width: `${Math.min(100, pct || 0)}%`,
                    ...(isOver ? { background: 'var(--danger)' } : {}),
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>
        <div className="travel-pass-stamp" aria-hidden="true">
          <span className="travel-pass-stamp-day num">{info.dayNum}</span>
          <span className="travel-pass-stamp-label">{stampLabel}</span>
        </div>
      </div>

      <div className="travel-hero-actions">
        <button type="button" className="btn tinted small travel-add-btn" onClick={onAddTripExpense}>
          記一筆旅行開銷
        </button>
        <button type="button" className="btn secondary small" onClick={onViewProject}>
          查看專案詳情
        </button>
      </div>

      <div className="travel-pass-barcode" aria-hidden="true" />
    </section>
  );
}

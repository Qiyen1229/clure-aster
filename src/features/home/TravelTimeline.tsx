/**
 * 旅遊模式「旅程時間軸」：把日常月曆換成逐日明信片。
 * 每一天是一張明信片（天數戳章＋日期＋分類戳章＋當日花費），點開看當日明細與「記這天」。
 * 行前消費（機票等）排在旅程前、標「行前」；返程後整段變回顧（日均／記帳天數／筆數）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Account, Category, Project, Tag, Transaction } from '@/db/types';
import { listLedger } from '@/db/repo/ledger';
import { projectStats } from '@/db/repo/plan';
import { eachDay, fromDateKey, todayKey } from '@/domain/period';
import { useUI } from '@/stores/ui';
import { haptic } from '@/services/haptics';
import { Amount } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { LedgerRow } from '../ledger/LedgerRow';
import { tripDayInfo } from './TravelHero';

const WEEK_NAMES = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

export interface TripDay {
  date: string;
  /** 旅程內＝第幾天；行前／旅程後＝null */
  dayNum: number | null;
  kind: 'pre' | 'trip' | 'post';
  isToday: boolean;
  isFuture: boolean;
  expenseMinor: number;
  txCount: number;
  catIds: string[];
}

export function buildTripDays(
  project: Pick<Project, 'start' | 'end'>,
  txs: Transaction[],
  byDay: Map<string, number>,
  today: string
): TripDay[] {
  const txDates = txs.map((t) => t.date);
  const openEnd = project.end ?? txDates.reduce((m, d) => (d > m ? d : m), today);
  const tripDates = eachDay({ start: project.start, end: openEnd });
  const indexOf = new Map(tripDates.map((d, i) => [d, i + 1]));
  const all = [...new Set([...tripDates, ...txDates])].sort();
  const dayTxs = new Map<string, Transaction[]>();
  for (const t of txs) {
    const arr = dayTxs.get(t.date) ?? [];
    arr.push(t);
    dayTxs.set(t.date, arr);
  }
  return all.map((date) => {
    const list = dayTxs.get(date) ?? [];
    const catIds: string[] = [];
    for (const t of list) if (t.type !== 'income' && !catIds.includes(t.categoryId)) catIds.push(t.categoryId);
    const kind: TripDay['kind'] = date < project.start ? 'pre' : project.end && date > project.end ? 'post' : 'trip';
    return {
      date,
      dayNum: indexOf.get(date) ?? null,
      kind,
      isToday: date === today,
      isFuture: date > today,
      expenseMinor: byDay.get(date) ?? 0,
      txCount: list.length,
      catIds,
    };
  });
}

const shortDate = (key: string) => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;

interface DayDetailProps {
  date: string;
  project: Project;
  cats: Map<string, Category>;
  accounts: Map<string, Account>;
  tags: Map<string, Tag>;
}

function DayDetail({ date, project, cats, accounts, tags }: DayDetailProps) {
  const openAdd = useUI((s) => s.openAdd);
  const items = useLiveQuery(
    async () => (await listLedger(date, date)).filter((it) => it.kind === 'tx' && it.tx.projectId === project.id),
    [date, project.id]
  );
  return (
    <div className="tt-detail">
      {items && items.length > 0 ? (
        <div className="tt-detail-list">
          {items.map((it) => (
            <LedgerRow key={it.id} item={it} cats={cats} accounts={accounts} tags={tags} />
          ))}
        </div>
      ) : (
        <p className="tt-empty">這天還沒有記帳，旅途中的花費隨手記下來。</p>
      )}
      <button
        type="button"
        className="btn tinted small"
        onClick={() => { haptic('light'); openAdd({ date, projectId: project.id, currency: project.currency }); }}
      >
        記這天
      </button>
    </div>
  );
}

interface TravelTimelineProps {
  project: Project;
  cats: Map<string, Category>;
  accounts: Map<string, Account>;
  tags: Map<string, Tag>;
}

export function TravelTimeline({ project, cats, accounts, tags }: TravelTimelineProps) {
  const stats = useLiveQuery(() => projectStats(project), [project.id]);
  const today = todayKey();
  const days = useMemo(() => (stats ? buildTripDays(project, stats.txs, stats.byDay, today) : null), [stats, project, today]);
  const info = tripDayInfo(project, today);
  const [open, setOpen] = useState<string | null>(null);
  const autoOpened = useRef(false);
  const todayRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!days || autoOpened.current) return;
    autoOpened.current = true;
    const t = days.find((d) => d.isToday);
    if (t) {
      setOpen(t.date);
      requestAnimationFrame(() => todayRef.current?.scrollIntoView({ block: 'nearest' }));
    }
  }, [days]);

  if (!days || !stats) return null;
  const recorded = days.filter((d) => d.kind === 'trip' && d.txCount > 0).length;
  const tripDays = days.filter((d) => d.kind === 'trip').length;

  return (
    <section className="travel-timeline" aria-label="旅程每日時間軸">
      <div className="travel-timeline-head">
        <h3>{info.phase === 'after' ? '旅程回顧' : '旅程時間軸'}</h3>
        <span className="travel-timeline-sub num">{tripDays} 天・{recorded} 天有記帳</span>
      </div>

      {info.phase === 'after' && info.totalDays ? (
        <div className="tt-recap">
          <div className="tt-recap-cell">
            <div className="tt-recap-val num">
              <Amount minor={Math.round(stats.expense / info.totalDays)} currency={project.currency} tone="none" opts={{ decimals: 0 }} />
            </div>
            <div className="tt-recap-label">日均花費</div>
          </div>
          <div className="tt-recap-cell">
            <div className="tt-recap-val num">{recorded}</div>
            <div className="tt-recap-label">記帳天數</div>
          </div>
          <div className="tt-recap-cell">
            <div className="tt-recap-val num">{stats.txs.length}</div>
            <div className="tt-recap-label">總筆數</div>
          </div>
        </div>
      ) : null}

      <ol className="tt-list">
        {days.map((d) => {
          const expanded = open === d.date;
          const catsOfDay = d.catIds.map((id) => cats.get(id)).filter((c): c is Category => !!c);
          return (
            <li
              key={d.date}
              ref={d.isToday ? todayRef : undefined}
              className={`tt-day${d.isToday ? ' today' : ''}${d.isFuture ? ' future' : ''}${expanded ? ' open' : ''}`}
            >
              <span className="tt-rail" aria-hidden="true">
                <i className="tt-dot" />
              </span>
              <button
                type="button"
                className="tt-card"
                aria-expanded={expanded}
                onClick={() => { haptic('selection'); setOpen(expanded ? null : d.date); }}
              >
                <span className="tt-stamp num" aria-hidden="true">
                  {d.dayNum ?? (d.kind === 'pre' ? '✈' : '✓')}
                </span>
                <span className="tt-main">
                  <span className="tt-date num">
                    {shortDate(d.date)}
                    <span className="tt-week">{WEEK_NAMES[fromDateKey(d.date).getDay()]}</span>
                    {d.isToday && <em className="tt-tag">今天</em>}
                    {d.kind === 'pre' && <em className="tt-tag pre">行前</em>}
                    {d.kind === 'post' && <em className="tt-tag pre">旅程後</em>}
                  </span>
                  <span className="tt-cats">
                    {catsOfDay.length > 0 ? (
                      catsOfDay.slice(0, 5).map((c) => (
                        <span key={c.id} className="tt-cat" title={c.name}>{c.icon}</span>
                      ))
                    ) : (
                      <span className="tt-note">{d.isFuture ? '尚未出發' : d.expenseMinor > 0 ? '' : '尚未記帳'}</span>
                    )}
                    {catsOfDay.length > 5 && <span className="tt-note">+{catsOfDay.length - 5}</span>}
                  </span>
                </span>
                <span className="tt-amt num">
                  {d.isFuture && d.txCount === 0 ? '—' : (
                    <Amount minor={d.expenseMinor} currency={project.currency} tone="none" opts={{ decimals: 0 }} />
                  )}
                </span>
                <Icon name="chevronD" size={14} className="tt-chev" />
              </button>
              {expanded && <DayDetail date={d.date} project={project} cats={cats} accounts={accounts} tags={tags} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
/**
 * Aster 首頁（中央 Tab）——一個畫面一個重點：
 * - 頂部：月份、（不是今天時的）回今天、搜尋、提醒。
 * - 下拉刷新：頁面頂端往下拉即可立即觸發雲端同步與匯率更新。
 * - 主角：這個月花了多少（一個大數字＋結餘／今日還可花）。
 * - 週曆（預設收成一週，可展開整月）。
 * - 當日：一行標題（日期＋支出／收入）＋帳目清單；「全部 ›」進帳目列表。
 * - 小工具預設不在首頁（設定 → 首頁快覽配置可加回）。
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { listLedger, listStatTxs } from '@/db/repo/ledger';
import { addDays, fromDateKey, monthGrid, toDateKey, todayKey } from '@/domain/period';
import { totals, totalsByDay } from '@/domain/ledger';
import { computePnlCalendar, type DayPnlResult, type MonthPnlSummary } from '@/domain/invest/pnlCalendar';
import { useAccounts, useCategories, useTags } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Icon } from '@/ui/Icon';
import { isOverlayTouch } from '@/ui/PullToRefresh';
import { Amount, EmptyState, SkeletonRows } from '@/ui/controls';
import { Calendar } from './Calendar';
import { MonthPicker } from './MonthPicker';
import { HomeHero } from './HomeHero';
import { TravelHero } from './TravelHero';
import { RemindersSheet, useUnreadCount } from './RemindersSheet';
import { useInboxCount } from '@/services/inboxCount';
import { syncNow } from '@/services/sync';
import { refreshRates } from '@/services/fx';
import { haptic } from '@/services/haptics';
import { LedgerRow } from '../ledger/LedgerRow';

const Widgets = lazy(() => import('./Widgets').then((m) => ({ default: m.Widgets })));
const WEEK_NAMES = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const PTR_THRESHOLD = 58;

export default function HomePage() {
  const navigate = useNavigate();
  const selected = useUI((s) => s.selectedDate);
  const setSelected = useUI((s) => s.setSelectedDate);
  const openAdd = useUI((s) => s.openAdd);
  const { weekStart, calendarCollapsed, baseCurrency, homeWidgets, travelModeProjectId, set } = useSettings();
  const travelProject = useLiveQuery(
    () => (travelModeProjectId ? db.projects.get(travelModeProjectId) : undefined),
    [travelModeProjectId]
  );
  const travelProjects = useLiveQuery(
    () => db.projects.filter((p) => !p.deletedAt && p.status === 'active' && !!p.isTravel).toArray(),
    []
  );
  const [calendarMode, setCalendarMode] = useState<'ledger' | 'pnl'>('ledger');
  const [pnlListOpen, setPnlListOpen] = useState(true);
  const effectiveCalendarMode = travelProject ? 'ledger' : calendarMode;
  const [monthOpen, setMonthOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const unread = useUnreadCount() + useInboxCount((x) => x.n + x.extra);

  // 下拉刷新（Pull-to-Refresh）：硬體加速、零重繪
  const [armed, setArmed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const ptrRef = useRef<{
    startY: number;
    startX: number;
    active: boolean;
    armed: boolean;
    currentY: number;
    rafId: number;
  } | null>(null);

  const onTouchStart = (e: React.TouchEvent<HTMLElement>) => {
    if (refreshing || window.scrollY > 2 || isOverlayTouch(e.target)) return;
    const t = e.touches[0];
    if (!t) return;
    ptrRef.current = { startY: t.clientY, startX: t.clientX, active: false, armed: false, currentY: 0, rafId: 0 };
  };
  const onTouchMove = (e: React.TouchEvent<HTMLElement>) => {
    const st = ptrRef.current;
    if (!st || refreshing) return;
    const t = e.touches[0];
    if (!t) return;
    const dy = t.clientY - st.startY;
    const dx = Math.abs(t.clientX - st.startX);
    if (!st.active) {
      if (dy < 8 || dx > dy || window.scrollY > 2) {
        if (dx > 14 || dy < -4) ptrRef.current = null;
        return;
      }
      st.active = true;
      if (indicatorRef.current) indicatorRef.current.style.transition = 'none';
    }
    const damped = Math.max(0, Math.min(78, Math.pow(Math.max(0, dy - 8), 0.76) * 2.2));
    st.currentY = damped;

    if (damped >= PTR_THRESHOLD && !st.armed) {
      st.armed = true;
      setArmed(true);
      haptic('medium');
    } else if (damped < PTR_THRESHOLD && st.armed) {
      st.armed = false;
      setArmed(false);
      haptic('selection');
    }

    if (!st.rafId) {
      st.rafId = requestAnimationFrame(() => {
        if (ptrRef.current) {
          ptrRef.current.rafId = 0;
          const el = indicatorRef.current;
          if (el) {
            const y = ptrRef.current.currentY;
            el.style.transform = `translate3d(0, calc(var(--safe-t, 0px) + ${y + 8}px), 0)`;
            el.style.opacity = `${Math.min(1, y / 28)}`;
          }
        }
      });
    }
  };
  const onTouchEnd = () => {
    const st = ptrRef.current;
    ptrRef.current = null;
    if (!st || !st.active) return;
    if (st.rafId) cancelAnimationFrame(st.rafId);

    const el = indicatorRef.current;
    if (st.armed && !refreshing) {
      setRefreshing(true);
      if (el) {
        el.style.transition = 'transform 260ms cubic-bezier(0.2, 0.9, 0.3, 1), opacity 200ms ease';
        el.style.transform = 'translate3d(0, calc(var(--safe-t, 0px) + 52px), 0)';
        el.style.opacity = '1';
      }
      void Promise.allSettled([syncNow(), refreshRates(baseCurrency), import('@/services/inbox').then((m) => m.refreshInbox())]).finally(() => {
        haptic('success');
        window.setTimeout(() => {
          if (indicatorRef.current) {
            indicatorRef.current.style.transition = 'transform 240ms cubic-bezier(0.2, 0, 0, 1), opacity 180ms ease';
            indicatorRef.current.style.transform = 'translate3d(0, -60px, 0)';
            indicatorRef.current.style.opacity = '0';
          }
          window.setTimeout(() => {
            setRefreshing(false);
            setArmed(false);
          }, 240);
        }, 320);
      });
    } else {
      setArmed(false);
      if (el) {
        el.style.transition = 'transform 240ms cubic-bezier(0.2, 0, 0, 1), opacity 180ms ease';
        el.style.transform = 'translate3d(0, -60px, 0)';
        el.style.opacity = '0';
      }
    }
  };

  const sel = fromDateKey(selected);
  const year = sel.getFullYear();
  const month0 = sel.getMonth();
  const grid = useMemo(() => monthGrid(year, month0, weekStart), [year, month0, weekStart]);
  // 延伸包含前後一個月，確保滑動切換週與月時相鄰面板的小光點皆已預先載入
  const gridStart = useMemo(() => addDays(grid[0].key, -35), [grid]);
  const gridEnd = useMemo(() => addDays(grid[41].key, 35), [grid]);

  const accounts = useAccounts(true);
  const cats = useCategories();
  const tags = useTags();

  const stat = useLiveQuery(async () => {
    const travelId = travelProject?.id;
    const [rawTxs, trDays] = await Promise.all([
      listStatTxs(gridStart, gridEnd),
      travelId
        ? Promise.resolve([])
        : db.transfers.where('date').between(gridStart, gridEnd, true, true).toArray().then((r) => r.filter((t) => !t.deletedAt)),
    ]);
    const txs = travelId ? rawTxs.filter((t) => t.projectId === travelId) : rawTxs;
    const byDay = totalsByDay(txs);
    const days = new Set<string>([...txs.map((t) => t.date), ...trDays.map((t) => t.date)]);
    return { byDay, days };
  }, [gridStart, gridEnd, travelProject?.id]);

  const items = useLiveQuery(async () => {
    const list = await listLedger(selected, selected);
    return travelProject?.id
      ? list.filter((it) => it.kind === 'tx' && it.tx.projectId === travelProject.id)
      : list;
  }, [selected, travelProject?.id]);
  const dayTotal = useLiveQuery(async () => {
    const raw = await listStatTxs(selected, selected);
    const txs = travelProject?.id ? raw.filter((t) => t.projectId === travelProject.id) : raw;
    return totals(txs);
  }, [selected, travelProject?.id]);

  // 投資資料與盈虧日曆計算
  const invData = useLiveQuery(async () => {
    const [stocks, trades, priceCaches, priceHistories] = await Promise.all([
      db.stocks.toArray(),
      db.stock_trades.toArray(),
      db.price_cache.toArray(),
      db.price_history.toArray(),
    ]);
    return {
      stocks,
      trades: trades.filter((t) => !t.deletedAt),
      priceCaches,
      priceHistories: priceHistories.filter((h) => h.date >= gridStart && h.date <= gridEnd),
    };
  }, [gridStart, gridEnd]);

  const pnlData = useMemo(() => {
    if (!invData) {
      return {
        days: new Map<string, DayPnlResult>(),
        monthSummary: {
          monthKey: `${year}-${String(month0 + 1).padStart(2, '0')}`,
          byCurrency: new Map(),
          currencies: [],
          totalTrades: 0,
        } as MonthPnlSummary,
      };
    }
    return computePnlCalendar({
      stocks: invData.stocks,
      trades: invData.trades,
      priceCaches: invData.priceCaches,
      priceHistories: invData.priceHistories,
      startDate: gridStart,
      endDate: gridEnd,
      today: todayKey(),
      monthKey: `${year}-${String(month0 + 1).padStart(2, '0')}`,
    });
  }, [invData, gridStart, gridEnd, year, month0]);

  const selectedDayPnl = pnlData.days.get(selected);

  // 切換到盈虧日曆時，若有持股尚未取得近 30 天日線，於背景預載入
  useEffect(() => {
    if (calendarMode !== 'pnl' || !invData) return;
    const heldStockIds = new Set(invData.trades.map((t) => t.stockId));
    const heldStocks = invData.stocks.filter((s) => heldStockIds.has(s.id));
    if (heldStocks.length === 0) return;

    const cachedIds = new Set(invData.priceHistories.map((h) => h.stockId));
    for (const stock of heldStocks) {
      if (!cachedIds.has(stock.id)) {
        import('@/services/quotes/registry').then((m) => {
          m.fetchHistory(stock, '1m').catch(() => {});
        });
      }
    }
  }, [calendarMode, invData]);

  const goMonth = (y: number, m0: number) => {
    const target = new Date(y, m0, 1);
    const today = todayKey();
    const t = fromDateKey(today);
    // 切到「本月」時直接選今天，否則選該月 1 號
    if (t.getFullYear() === target.getFullYear() && t.getMonth() === target.getMonth()) setSelected(today);
    else setSelected(toDateKey(target));
  };
  const shiftMonth = (d: number) => goMonth(year, month0 + d);

  const shiftWeek = (d: number) => {
    setSelected(addDays(selected, d * 7));
  };

  const isToday = selected === todayKey();
  const incomeTotal = dayTotal?.income ?? 0;
  const expenseTotal = dayTotal?.expense ?? 0;

  return (
    <main
      className="page home-page"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {/* 下拉刷新指示器（浮動膠囊，零佈局重繪硬體加速） */}
      <div
        ref={indicatorRef}
        className={`ptr-indicator${refreshing ? ' refreshing' : armed ? ' armed' : ''}`}
        aria-live="polite"
      >
        <span className="ptr-pill">
          <span className="ptr-spinner" aria-hidden="true" />
          <span>{refreshing ? '同步更新中…' : armed ? '放開立即同步' : '下拉同步'}</span>
        </span>
      </div>

      {/* 頂部功能列：月份選取 + 動作按鈕 */}
      <header className="home-topbar">
        <button
          className="month-selector-btn"
          aria-label={`選擇月份，目前 ${year} 年 ${month0 + 1} 月`}
          aria-haspopup="dialog"
          onClick={() => { haptic('selection'); setMonthOpen(true); }}
        >
          <span className="month-selector-text num">{year} 年 {month0 + 1} 月</span>
          <Icon name="chevronD" size={14} className="month-selector-icon" />
        </button>

        <div className="home-topbar-actions">
          {travelProjects && travelProjects.length > 0 && (
            <button
              className="chip-today-btn"
              onClick={() => {
                haptic('selection');
                set('travelModeProjectId', travelProject ? null : travelProjects[0].id);
              }}
            >
              {travelProject ? '一般模式' : '旅遊模式'}
            </button>
          )}
          {!isToday && (
            <button className="chip-today-btn" onClick={() => { haptic('light'); setSelected(todayKey()); }}>
              今天
            </button>
          )}
          <button className="icon-btn" aria-label="搜尋" onClick={() => { haptic('selection'); navigate('/search'); }}>
            <Icon name="search" />
          </button>
          <button
            className="icon-btn"
            aria-label={`提醒${unread ? `（${unread} 則未讀）` : ''}`}
            onClick={() => { haptic('selection'); setRemindersOpen(true); }}
            style={{ position: 'relative' }}
          >
            <Icon name="bell" />
            {unread > 0 && <span className="badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
          </button>
        </div>
      </header>

      {travelProject ? (
        <TravelHero
          project={travelProject}
          onSwitchNormal={() => set('travelModeProjectId', null)}
          onAddTripExpense={() => openAdd({ date: selected, projectId: travelProject.id, currency: travelProject.currency })}
          onViewProject={() => navigate(`/plan/projects/${travelProject.id}`)}
        />
      ) : (
        <HomeHero
          selected={selected}
          mode={effectiveCalendarMode}
          pnlSummary={pnlData.monthSummary}
        />
      )}

      {/* 膠囊週曆（可平滑展開為全月，支援記帳與盈虧雙模式；旅遊模式下隱藏盈虧切換） */}
      <Calendar
        year={year}
        month0={month0}
        selected={selected}
        weekStart={weekStart}
        dayTotals={stat?.byDay ?? new Map()}
        daysWithRecords={stat?.days ?? new Set()}
        collapsed={calendarCollapsed}
        mode={effectiveCalendarMode}
        hidePnlToggle={!!travelProject}
        pnlDays={pnlData.days}
        monthPnlSummary={pnlData.monthSummary}
        onSelect={setSelected}
        onMonthShift={shiftMonth}
        onWeekShift={shiftWeek}
        onToggleCollapse={() => set('calendarCollapsed', !calendarCollapsed)}
        onModeChange={setCalendarMode}
      />

      {/* 當日：一行標題（記帳模式：支出／收入；盈虧模式：分幣別投資淨利淨損） */}
      <div className="day-head">
        <div className="day-head-title">
          <span className="date-text num">{Number(selected.slice(5, 7))}/{Number(selected.slice(8))}</span>
          <span className="weekday-text">{WEEK_NAMES[sel.getDay()]}</span>
          {isToday && <span className="today-badge">今天</span>}
        </div>
        {effectiveCalendarMode === 'ledger' ? (
          <div className="day-head-sum num">
            <span>支出 <Amount minor={expenseTotal} currency={baseCurrency} tone="none" opts={{ decimals: 0 }} /></span>
            {incomeTotal > 0 && <span>收入 <Amount minor={incomeTotal} currency={baseCurrency} tone="pos" opts={{ decimals: 0 }} /></span>}
          </div>
        ) : (
          <div className="day-head-sum num pnl-head-sum">
            {selectedDayPnl && selectedDayPnl.currencies.length > 0 ? (
              selectedDayPnl.currencies.map((c) => {
                const isPos = c.pnlMinor > 0;
                const isNeg = c.pnlMinor < 0;
                const tone = isPos ? 'pos' : isNeg ? 'neg' : 'flat';
                const sign = isPos ? '+' : isNeg ? '-' : '';
                const val = (Math.abs(c.pnlMinor) / 100).toLocaleString('en-US', {
                  maximumFractionDigits: c.currency === 'TWD' ? 0 : 2,
                });
                const pctStr = `${c.pnlPct >= 0 ? '+' : ''}${c.pnlPct.toFixed(1)}%`;
                return (
                  <span key={c.currency} className={`pnl-head-pill ${tone}`}>
                    {c.currency === 'TWD' ? 'NT$' : 'US$'}&nbsp;{`${sign}${val}`}
                    <span className="pnl-head-pct">({pctStr})</span>
                  </span>
                );
              })
            ) : (
              <span className="pnl-head-empty">本日無持股波動</span>
            )}
          </div>
        )}
        {effectiveCalendarMode === 'ledger' ? (
          <button className="day-head-all" onClick={() => navigate('/ledger')} aria-label="全部帳目">
            全部 <Icon name="chevronR" size={14} />
          </button>
        ) : (
          <button className="day-head-all" onClick={() => navigate('/invest')} aria-label="投資總覽">
            投資總覽 <Icon name="chevronR" size={14} />
          </button>
        )}
      </div>

      {/* 當日帳目明細清單 或 股票明細清單 */}
      {effectiveCalendarMode === 'ledger' ? (
        <section className="day-ledger-section" aria-label="當日帳目明細">
          {!items || cats.loading || accounts.loading ? (
            <SkeletonRows n={3} />
          ) : items.length === 0 ? (
            <EmptyState
              emoji="🧾"
              title="這天尚無記帳紀錄"
              text="花 3 秒記一筆，養成清晰的財務好習慣。"
              action={<button className="btn tinted small" onClick={() => openAdd({ date: selected, projectId: travelProject?.id, currency: travelProject?.currency })}>記一筆</button>}
            />
          ) : (
            <div className="day-ledger-list">
              {items.map((it) => (
                <LedgerRow key={it.id} item={it} cats={cats.map} accounts={accounts.map} tags={tags.map} />
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="day-ledger-section day-pnl-section" aria-label="當日股票明細">
          {!selectedDayPnl || selectedDayPnl.stocks.length === 0 ? (
            <EmptyState
              emoji="📈"
              title="這天無股票交易或持股波動"
              text="這天未進行股票平倉，股市亦無收盤變動或無持股。"
              action={<button className="btn tinted small" onClick={() => navigate('/invest')}>查看投資組合</button>}
            />
          ) : (
            <>
              <button
                type="button"
                className="pnl-list-toggle"
                aria-expanded={pnlListOpen}
                onClick={() => { haptic('selection'); setPnlListOpen((v) => !v); }}
              >
                <span>當日持股明細（{selectedDayPnl.stocks.length}）</span>
                <Icon name={pnlListOpen ? 'up' : 'chevronD'} size={14} />
              </button>
              {pnlListOpen && (
                <div className="day-pnl-list">
              {selectedDayPnl.stocks.map((s) => {
                const isPos = s.pnlMinor > 0;
                const isNeg = s.pnlMinor < 0;
                const tone = isPos ? 'pos' : isNeg ? 'neg' : 'flat';
                const sign = isPos ? '+' : isNeg ? '-' : '';
                const val = (Math.abs(s.pnlMinor) / 100).toLocaleString('en-US', {
                  maximumFractionDigits: s.currency === 'TWD' ? 0 : 2,
                });
                return (
                  <button
                    key={s.stockId}
                    type="button"
                    className="day-stock-card"
                    onClick={() => {
                      haptic('light');
                      navigate(`/invest/stock/${s.stockId}`);
                    }}
                  >
                    <div className="stock-card-left">
                      <div className="stock-card-title-row">
                        <span className="stock-card-name">{s.name}</span>
                        <span className="stock-card-symbol num">{s.symbol}</span>
                        <span className="stock-card-market chip">{s.market}</span>
                      </div>
                      <div className="stock-card-sub">
                        {s.trades.length > 0 ? (
                          <span className="stock-card-action">
                            {s.tradeType === 'buy' ? '買進' : s.tradeType === 'sell' ? '賣出' : '當沖沖銷'} {s.tradeShares} 股
                            {s.tradePrice ? ` @ $${s.tradePrice}` : ''}
                          </span>
                        ) : (
                          <span className="stock-card-held">
                            持股 {s.heldShares} 股 · 收盤 ${s.closePriceDec}
                            {s.priceChangePct !== undefined ? ` (${s.priceChangePct >= 0 ? '+' : ''}${s.priceChangePct.toFixed(2)}%)` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="stock-card-right num">
                      <div className={`stock-card-pnl ${tone}`}>
                        {s.currency === 'TWD' ? 'NT$' : 'US$'}&nbsp;{`${sign}${val}`}
                      </div>
                      {s.realizedMinor !== 0 && s.unrealizedChangeMinor !== 0 ? (
                        <div className="stock-card-pnl-sub">
                          已實現 {s.realizedMinor >= 0 ? '+' : ''}{(s.realizedMinor / 100).toLocaleString('en-US')}
                        </div>
                      ) : s.realizedMinor !== 0 ? (
                        <div className="stock-card-pnl-sub">已實現平倉</div>
                      ) : (
                        <div className="stock-card-pnl-sub">持股收盤波動</div>
                      )}
                    </div>
                  </button>
                );
              })}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* 下半部獨立區塊：快覽（今日可用、預算、淨資產…可在設定增減）；旅遊模式下隱藏一般日常快覽 */}
      {!travelProject && (
        <div className="home-lower" aria-label="快覽">
          {homeWidgets.length > 0 && <Suspense fallback={null}><Widgets /></Suspense>}
        </div>
      )}

      <MonthPicker open={monthOpen} onClose={() => setMonthOpen(false)} year={year} month0={month0} onPick={goMonth} />
      <RemindersSheet open={remindersOpen} onClose={() => setRemindersOpen(false)} />
    </main>
  );
}

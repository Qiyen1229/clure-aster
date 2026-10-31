/**
 * Aster 首頁（中央 Tab）——一個畫面一個重點：
 * - 頂部：月份、（不是今天時的）回今天、AI 小圓球、搜尋、提醒。
 * - 主角：這個月花了多少（一個大數字＋結餘／今日還可花）。
 * - 週曆（預設收成一週，可展開整月）。
 * - 當日：一行標題（日期＋支出／收入）＋帳目清單；「全部 ›」進帳目列表。
 * - 「需要你看一下」：收件匣、預算預警、異常偵測、AI 上週重點併成一張卡，沒事就不出現。
 * - 小工具預設不在首頁（設定 → 首頁小工具可加回）。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { listLedger, listStatTxs } from '@/db/repo/ledger';
import { addDays, fromDateKey, monthGrid, toDateKey, todayKey } from '@/domain/period';
import { totals, totalsByDay } from '@/domain/ledger';
import { useAccounts, useCategories, useTags } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Icon } from '@/ui/Icon';
import { Amount, EmptyState, SkeletonRows } from '@/ui/controls';
import { Calendar } from './Calendar';
import { Widgets } from './Widgets';
import { AiChatSheet, AiOrb } from './AiChat';
import { MonthPicker } from './MonthPicker';
import { AttentionCard } from './AttentionCard';
import { HomeHero } from './HomeHero';
import { RemindersSheet, useUnreadCount } from './RemindersSheet';
import { LedgerRow } from '../ledger/LedgerRow';

const WEEK_NAMES = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

export default function HomePage() {
  const navigate = useNavigate();
  const selected = useUI((s) => s.selectedDate);
  const setSelected = useUI((s) => s.setSelectedDate);
  const openAdd = useUI((s) => s.openAdd);
  const { weekStart, calendarCollapsed, baseCurrency, homeAiChat, homeWidgets, set } = useSettings();
  const [monthOpen, setMonthOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const unread = useUnreadCount();

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
    const [txs, trDays] = await Promise.all([
      listStatTxs(gridStart, gridEnd),
      db.transfers.where('date').between(gridStart, gridEnd, true, true).filter((t) => !t.deletedAt).toArray(),
    ]);
    const byDay = totalsByDay(txs);
    const days = new Set<string>([...txs.map((t) => t.date), ...trDays.map((t) => t.date)]);
    return { byDay, days };
  }, [gridStart, gridEnd]);

  const items = useLiveQuery(() => listLedger(selected, selected), [selected]);
  const dayTotal = useLiveQuery(async () => totals(await listStatTxs(selected, selected)), [selected]);

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
    <main className="page home-page">
      {/* 頂部功能列：月份選取 + 動作按鈕 */}
      <header className="home-topbar">
        <button
          className="month-selector-btn"
          aria-label={`選擇月份，目前 ${year} 年 ${month0 + 1} 月`}
          aria-haspopup="dialog"
          onClick={() => setMonthOpen(true)}
        >
          <span className="month-selector-text num">{year} 年 {month0 + 1} 月</span>
          <Icon name="chevronD" size={14} className="month-selector-icon" />
        </button>

        <div className="home-topbar-actions">
          {!isToday && (
            <button className="chip-today-btn" onClick={() => setSelected(todayKey())}>
              今天
            </button>
          )}
          {homeAiChat && <AiOrb />}
          <button className="icon-btn" aria-label="搜尋" onClick={() => navigate('/search')}>
            <Icon name="search" />
          </button>
          <button
            className="icon-btn"
            aria-label={`提醒${unread ? `（${unread} 則未讀）` : ''}`}
            onClick={() => setRemindersOpen(true)}
            style={{ position: 'relative' }}
          >
            <Icon name="bell" />
            {unread > 0 && <span className="badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
          </button>
        </div>
      </header>

      <HomeHero selected={selected} />

      {/* 膠囊週曆（可平滑展開為全月） */}
      <Calendar
        year={year}
        month0={month0}
        selected={selected}
        weekStart={weekStart}
        dayTotals={stat?.byDay ?? new Map()}
        daysWithRecords={stat?.days ?? new Set()}
        collapsed={calendarCollapsed}
        onSelect={setSelected}
        onMonthShift={shiftMonth}
        onWeekShift={shiftWeek}
        onToggleCollapse={() => set('calendarCollapsed', !calendarCollapsed)}
      />

      {/* 當日：一行標題（日期＋支出／收入） */}
      <div className="day-head">
        <div className="day-head-title">
          <span className="date-text num">{Number(selected.slice(5, 7))}/{Number(selected.slice(8))}</span>
          <span className="weekday-text">{WEEK_NAMES[sel.getDay()]}</span>
          {isToday && <span className="today-badge">今天</span>}
        </div>
        <div className="day-head-sum num">
          <span>支出 <Amount minor={expenseTotal} currency={baseCurrency} tone="none" opts={{ decimals: 0 }} /></span>
          {incomeTotal > 0 && <span>收入 <Amount minor={incomeTotal} currency={baseCurrency} tone="pos" opts={{ decimals: 0 }} /></span>}
        </div>
        <button className="day-head-all" onClick={() => navigate('/ledger')} aria-label="全部帳目">全部 <Icon name="chevronR" size={14} /></button>
      </div>

      {/* 當日帳目明細清單 */}
      <section className="day-ledger-section" aria-label="當日帳目明細">
        {!items || cats.loading || accounts.loading ? (
          <SkeletonRows n={3} />
        ) : items.length === 0 ? (
          <EmptyState
            emoji="🧾"
            title="這天尚無記帳紀錄"
            text="花 3 秒記一筆，養成清晰的財務好習慣。"
            action={<button className="btn tinted small" onClick={() => openAdd({ date: selected })}>記一筆</button>}
          />
        ) : (
          <div className="day-ledger-list">
            {items.map((it) => (
              <LedgerRow key={it.id} item={it} cats={cats.map} accounts={accounts.map} tags={tags.map} />
            ))}
          </div>
        )}
      </section>

      {/* 下半部獨立區塊：需要你看一下（收件匣、預算預警、異常偵測、AI 上週重點）與小工具；都沒有內容時整塊隱藏 */}
      <div className="home-lower" aria-label="提醒與快覽">
        <AttentionCard />
        {homeWidgets.length > 0 && <Widgets />}
      </div>

      <MonthPicker open={monthOpen} onClose={() => setMonthOpen(false)} year={year} month0={month0} onPick={goMonth} />
      <RemindersSheet open={remindersOpen} onClose={() => setRemindersOpen(false)} />
      <AiChatSheet />
    </main>
  );
}

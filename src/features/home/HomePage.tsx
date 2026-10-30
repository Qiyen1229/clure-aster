/**
 * Aster 智慧財務首頁（中央 Tab）：
 * - 頂部：月份選擇器、快速「回今天」、提醒通知、全域搜尋與帳目列表。
 * - 頂部膠囊週曆：7 天極簡膠囊，顯示微型小光點（•），支援左右滑動切換週與「展開整月」。
 * - 當日收支脈搏 Bento 卡片：直觀呈現選取日之支出/收入雙欄與一鍵「＋ 記一筆」。
 * - 當日帳目明細流：專注呈現選取日的交易卡片。
 * - 延伸區塊：AI 洞察分析卡片與財務小工具（投資損益、預算燃盡、淨資產）。
 */
import { useMemo, useRef, useState } from 'react';
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
import { AiChatBar, AiChatSheet } from './AiChat';
import { AiAutoCard } from '../ai/AiAutoCard';
import { RemindersSheet, useUnreadCount } from './RemindersSheet';
import { LedgerRow } from '../ledger/LedgerRow';
import { useInboxCount } from '@/services/inbox';

const WEEK_NAMES = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

export default function HomePage() {
  const navigate = useNavigate();
  const selected = useUI((s) => s.selectedDate);
  const setSelected = useUI((s) => s.setSelectedDate);
  const openAdd = useUI((s) => s.openAdd);
  const { weekStart, calendarCollapsed, baseCurrency, homeAiChat, set } = useSettings();
  const dateInput = useRef<HTMLInputElement>(null);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const unread = useUnreadCount();
  const inboxCount = useInboxCount((s) => s.n);

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

  const shiftMonth = (d: number) => {
    const target = new Date(year, month0 + d, 1);
    const today = todayKey();
    const t = fromDateKey(today);
    // 切到「本月」時直接選今天，否則選該月 1 號
    if (t.getFullYear() === target.getFullYear() && t.getMonth() === target.getMonth()) setSelected(today);
    else setSelected(toDateKey(target));
  };

  const shiftWeek = (d: number) => {
    setSelected(addDays(selected, d * 7));
  };

  const isToday = selected === todayKey();
  const expenseCount = items?.filter((it) => it.kind === 'tx' && it.tx.type === 'expense').length ?? 0;
  const incomeTotal = dayTotal?.income ?? 0;
  const expenseTotal = dayTotal?.expense ?? 0;
  const netBalance = incomeTotal - expenseTotal;

  return (
    <main className="page home-page">
      {/* 頂部功能列：月份選取 + 動作按鈕 */}
      <header className="home-topbar">
        <button
          className="month-selector-btn"
          aria-label={`選擇月份，目前 ${year} 年 ${month0 + 1} 月`}
          onClick={() => {
            const el = dateInput.current;
            if (el) {
              try { el.showPicker(); } catch { el.focus(); el.click(); }
            }
          }}
        >
          <span className="month-selector-text num">{year} 年 {month0 + 1} 月</span>
          <Icon name="chevronD" size={14} className="month-selector-icon" />
        </button>
        <input
          ref={dateInput}
          type="date"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          value={selected}
          onChange={(e) => e.target.value && setSelected(e.target.value)}
        />

        <div className="home-topbar-actions">
          {!isToday && (
            <button className="chip-today-btn" onClick={() => setSelected(todayKey())}>
              回今天
            </button>
          )}
          <button
            className="icon-btn"
            aria-label={`提醒${unread ? `（${unread} 則未讀）` : ''}`}
            onClick={() => setRemindersOpen(true)}
            style={{ position: 'relative' }}
          >
            <Icon name="bell" />
            {unread > 0 && <span className="badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
          </button>
          <button className="icon-btn" aria-label="搜尋" onClick={() => navigate('/search')}>
            <Icon name="search" />
          </button>
          <button className="icon-btn" aria-label="帳目列表" onClick={() => navigate('/ledger')}>
            <Icon name="list" />
          </button>
        </div>
      </header>

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

      {/* 當日收支脈搏 Bento 卡片 */}
      <section className="day-bento-card" aria-label="當日收支總覽">
        <div className="day-bento-header">
          <div className="day-bento-title">
            <span className="date-text num">{Number(selected.slice(5, 7))} 月 {Number(selected.slice(8))} 日</span>
            <span className="weekday-text">{WEEK_NAMES[sel.getDay()]}</span>
            {isToday && <span className="today-badge">今天</span>}
          </div>
        </div>

        <div className="day-bento-grid">
          <div className="day-bento-tile expense">
            <div className="tile-label">本日支出</div>
            <div className="tile-amount num">
              <Amount minor={expenseTotal} currency={baseCurrency} tone="none" />
            </div>
            <div className="tile-sub">
              {items ? `${expenseCount} 筆支出` : '計算中…'}
            </div>
          </div>

          <div className="day-bento-tile income">
            <div className="tile-label">本日收入</div>
            <div className="tile-amount num">
              <Amount minor={incomeTotal} currency={baseCurrency} tone={incomeTotal > 0 ? 'pos' : 'none'} />
            </div>
            <div className="tile-sub">
              {incomeTotal > 0 ? (
                <>
                  淨結餘{' '}
                  <Amount minor={netBalance} currency={baseCurrency} tone={netBalance >= 0 ? 'pos' : 'neg'} />
                </>
              ) : (
                '尚無入帳'
              )}
            </div>
          </div>
        </div>
      </section>

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

      {/* 延伸模組：收件匣、AI 洞察與即時財務小工具 */}
      {inboxCount > 0 && (
        <button className="inbox-banner" onClick={() => navigate('/inbox')}>
          <span aria-hidden="true">📥</span>
          <span className="row-main">收件匣有 <b>{inboxCount}</b> 筆待確認</span>
          <Icon name="chevronR" size={18} />
        </button>
      )}

      {homeAiChat && <AiChatBar />}
      <AiAutoCard />

      <Widgets />

      <RemindersSheet open={remindersOpen} onClose={() => setRemindersOpen(false)} />
      <AiChatSheet />
    </main>
  );
}

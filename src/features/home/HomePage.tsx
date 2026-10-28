/**
 * 記帳主頁（中央 Tab）：頂部 提醒｜日期｜列表切換｜搜尋，月曆網格，選取日的收支明細。
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { listLedger, listStatTxs } from '@/db/repo/ledger';
import { fromDateKey, monthGrid, toDateKey, todayKey } from '@/domain/period';
import { totals, totalsByDay } from '@/domain/ledger';
import { useAccounts, useCategories, useTags } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Icon } from '@/ui/Icon';
import { Amount, EmptyState, SkeletonRows } from '@/ui/controls';
import { Calendar } from './Calendar';
import { Widgets } from './Widgets';
import { AiChatBar, AiChatSheet } from './AiChat';
import { RemindersSheet, useUnreadCount } from './RemindersSheet';
import { LedgerRow } from '../ledger/LedgerRow';
import { useInboxCount } from '@/services/inbox';

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
  const gridStart = grid[0].key;
  const gridEnd = grid[41].key;

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

  const isToday = selected === todayKey();
  const title = selected.replace(/-/g, '/');

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label={`提醒${unread ? `（${unread} 則未讀）` : ''}`} onClick={() => setRemindersOpen(true)} style={{ position: 'relative' }}>
          <Icon name="bell" />
          {unread > 0 && <span className="badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <button className="title-btn num" aria-label={`選擇日期，目前 ${title}`}
          onClick={() => { const el = dateInput.current; if (el) { try { el.showPicker(); } catch { el.focus(); el.click(); } } }}>
          {title}
        </button>
        <input ref={dateInput} type="date" className="sr-only" tabIndex={-1} aria-hidden="true" value={selected}
          onChange={(e) => e.target.value && setSelected(e.target.value)} />
        <button className="icon-btn" aria-label="帳目列表" onClick={() => navigate('/ledger')}>
          <Icon name="list" />
        </button>
        <button className="icon-btn" aria-label="搜尋" onClick={() => navigate('/search')}>
          <Icon name="search" />
        </button>
      </header>

      <Calendar year={year} month0={month0} selected={selected} weekStart={weekStart}
        dayTotals={stat?.byDay ?? new Map()} daysWithRecords={stat?.days ?? new Set()}
        collapsed={calendarCollapsed} onSelect={setSelected} onMonthShift={shiftMonth} />

      <button className="cal-handle" aria-label={calendarCollapsed ? '展開月曆' : '收合月曆'} aria-expanded={!calendarCollapsed}
        onClick={() => set('calendarCollapsed', !calendarCollapsed)} />

      {inboxCount > 0 && (
        <button className="inbox-banner" onClick={() => navigate('/inbox')}>
          <span aria-hidden="true">📥</span>
          <span className="row-main">收件匣有 <b>{inboxCount}</b> 筆待確認</span>
          <Icon name="chevronR" size={18} />
        </button>
      )}

      {homeAiChat && <AiChatBar />}

      <Widgets />

      <div className="day-summary">
        <span>
          {isToday ? '今天' : `${Number(selected.slice(5, 7))}月${Number(selected.slice(8))}日`}
          {!isToday && <button className="accent" style={{ marginLeft: 10, minHeight: 32 }} onClick={() => setSelected(todayKey())}>回今天</button>}
        </span>
        <span>
          支出 <b><Amount minor={dayTotal?.expense ?? 0} currency={baseCurrency} tone="none" /></b>
          {(dayTotal?.income ?? 0) > 0 && <> · 收入 <b><Amount minor={dayTotal!.income} currency={baseCurrency} tone="pos" /></b></>}
        </span>
      </div>

      {!items || cats.loading || accounts.loading ? (
        <SkeletonRows n={3} />
      ) : items.length === 0 ? (
        <EmptyState emoji="🧾" title="這天還沒有記帳" text="點下方 ＋ 或下面的按鈕，花 3 秒記一筆。"
          action={<button className="btn tinted small" onClick={() => openAdd({ date: selected })}>記一筆</button>} />
      ) : (
        <div>
          {items.map((it) => (
            <LedgerRow key={it.id} item={it} cats={cats.map} accounts={accounts.map} tags={tags.map} />
          ))}
        </div>
      )}
      <RemindersSheet open={remindersOpen} onClose={() => setRemindersOpen(false)} />
      <AiChatSheet />
    </main>
  );
}

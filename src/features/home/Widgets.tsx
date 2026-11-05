/**
 * 首頁小工具（可在「設定 → 首頁小工具」調整顯示與順序）：
 * 今日／本月花費、本月預算、淨資產、持股損益、近期帳單與訂閱、分帳債務、存錢目標。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { computeBudgets, goalSaved } from '@/db/repo/plan';
import { creditCardStatement } from '@/db/repo/accounts';
import { listStatTxs } from '@/db/repo/ledger';
import { totals } from '@/domain/ledger';
import { netByPerson } from '@/domain/debt';
import { accountingMonth, addDays, todayKey } from '@/domain/period';
import { accountsNetWorth } from '@/services/snapshots';
import { usePortfolio } from '@/services/portfolio';
import { useSettings } from '@/stores/settings';
import { Amount } from '@/ui/controls';
import type { WidgetKey } from '@/db/repo/settings';

function Card({ title, children, onClick }: { title: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <button className="widget" onClick={onClick}>
      <div className="widget-title">{title}</div>
      {children}
    </button>
  );
}

export function Widgets() {
  const keys = useSettings((s) => s.homeWidgets);
  const base = useSettings((s) => s.baseCurrency);
  const msd = useSettings((s) => s.monthStartDay);
  const navigate = useNavigate();
  const tick = useLiveQuery(() => db.transactions.count(), []);
  const today = todayKey();
  const month = accountingMonth(today, msd);
  const pf = usePortfolio();

  const data = useLiveQuery(async () => {
    const out: Record<string, unknown> = {};
    if (keys.includes('today')) {
      out.today = totals(await listStatTxs(today, today));
      out.month = totals(await listStatTxs(month.start, month.end));
    }
    if (keys.includes('budget')) out.budget = (await computeBudgets(today)).find((b) => !b.budget.categoryId) ?? (await computeBudgets(today))[0];
    if (keys.includes('networth')) out.nw = await accountsNetWorth();
    if (keys.includes('bills')) {
      const bills: { name: string; date: string; amount: number; currency: string }[] = [];
      for (const acc of await db.accounts.where('type').equals('credit').toArray()) {
        if (acc.archived || !acc.credit) continue;
        const st = await creditCardStatement(acc);
        if (st && st.statementMinor > 0 && st.cycle.dueDate >= today) bills.push({ name: acc.name, date: st.cycle.dueDate, amount: st.statementMinor, currency: acc.currency });
      }
      const limit = addDays(today, 14);
      for (const r of await db.recurring_rules.where('nextDue').between(today, limit, true, true).toArray()) {
        if (r.active && r.template.type !== 'income') bills.push({ name: r.name, date: r.nextDue, amount: r.template.amountMinor ?? 0, currency: r.template.currency ?? base });
      }
      out.bills = bills.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 3);
      out.pending = (await db.recurring_rules.toArray()).reduce((a, r) => a + r.pendingDates.length, 0);
    }
    if (keys.includes('debts')) {
      let owed = 0, owe = 0;
      for (const m of netByPerson(await db.debts.toArray()).values()) { const v = m.get(base) ?? 0; if (v > 0) owed += v; else owe -= v; }
      out.debts = { owed, owe };
    }
    if (keys.includes('wishlist')) {
      const all = await db.wishes.toArray();
      const w = all.filter((x) => x.status === 'waiting');
      out.wish = { waiting: w.length, due: w.filter((x) => x.decideAt <= today).length, saved: all.filter((x) => x.status === 'abandoned' && x.currency === base).reduce((a, x) => a + x.priceMinor, 0) };
    }
    if (keys.includes('goals')) {
      const g = (await db.goals.where('status').equals('active').toArray())[0];
      if (g) out.goal = { g, saved: await goalSaved(g) };
    }
    return out;
  }, [keys.join(), tick, msd, base]);

  if (!keys.length || !data) return null;
  const render = (k: WidgetKey) => {
    switch (k) {
      case 'today': {
        const t = data.today as ReturnType<typeof totals> | undefined, m = data.month as ReturnType<typeof totals> | undefined;
        return <Card key={k} title="今日支出" onClick={() => navigate('/ledger')}>
          <div className="widget-value num"><Amount minor={t?.expense ?? 0} currency={base} tone="none" /></div>
          <div className="widget-sub num">本月 <Amount minor={m?.expense ?? 0} currency={base} tone="none" /></div>
        </Card>;
      }
      case 'budget': {
        const b = data.budget as Awaited<ReturnType<typeof computeBudgets>>[number] | undefined;
        return <Card key={k} title="今日可用" onClick={() => navigate('/plan?tab=budget')}>
          {b ? <>
            <div className="widget-value num" style={{ fontSize: 'min(1.45rem, 16cqi)', color: b.status.todayLeft > 0 ? 'var(--danger)' : b.status.todayLeft < 0 ? 'var(--success)' : 'var(--text)' }}>
              <Amount minor={b.status.todayLeft} currency={b.budget.currency} tone="none" opts={{ decimals: 0 }} />
            </div>
            <div className="bar" style={{ margin: '4px 0' }}><i style={{ width: `${Math.min(100, b.status.pct)}%`, ['--c' as string]: b.status.level === 'over' ? 'var(--danger)' : b.status.level === 'warn' ? 'var(--warning)' : 'var(--accent)' }} /></div>
            <div className="widget-sub num">本月剩 <Amount minor={b.status.remaining} currency={b.budget.currency} tone="none" opts={{ decimals: 0 }} /></div>
          </> : <div className="widget-sub">尚未設定預算，點此建立</div>}
        </Card>;
      }
      case 'networth': {
        const n = data.nw as { assets: number; liabilities: number } | undefined;
        const v = (n ? n.assets - n.liabilities : 0) + (pf?.marketValueBase ?? 0);
        return <Card key={k} title="淨資產" onClick={() => navigate('/accounts')}>
          <div className="widget-value num"><Amount minor={v} currency={base} tone="none" opts={{ compact: true }} /></div>
          <div className="widget-sub num">投資 <Amount minor={pf?.marketValueBase ?? 0} currency={base} tone="none" opts={{ compact: true }} /></div>
        </Card>;
      }
      case 'invest':
        return <Card key={k} title="持股損益" onClick={() => navigate('/accounts?tab=invest')}>
          {pf && pf.holdings.length ? <>
            <div className="widget-value num"><Amount minor={pf.unrealizedBase} currency={base} tone="auto" opts={{ sign: 'always', compact: true }} /></div>
            <div className="widget-sub num">今日 <Amount minor={pf.todayBase} currency={base} tone="auto" opts={{ sign: 'always' }} /></div>
          </> : <div className="widget-sub">尚無持股</div>}
        </Card>;
      case 'bills': {
        const bills = data.bills as { name: string; date: string; amount: number; currency: string }[] | undefined;
        return <Card key={k} title={`近期帳單${(data.pending as number) ? `・${data.pending} 待確認` : ''}`} onClick={() => navigate('/plan?tab=recurring')}>
          {bills?.length ? bills.map((b) => (
            <div key={b.name + b.date} className="widget-sub" style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.date.slice(5).replace('-', '/')} {b.name}</span>
              <Amount minor={b.amount} currency={b.currency} tone="none" className="num" />
            </div>
          )) : <div className="widget-sub">14 天內沒有帳單</div>}
        </Card>;
      }
      case 'debts': {
        const d = data.debts as { owed: number; owe: number } | undefined;
        return <Card key={k} title="分帳" onClick={() => navigate('/plan?tab=debt')}>
          <div className="widget-sub">別人欠我 <Amount minor={d?.owed ?? 0} currency={base} tone="pos" /></div>
          <div className="widget-sub">我欠別人 <Amount minor={d?.owe ?? 0} currency={base} tone="neg" /></div>
        </Card>;
      }
      case 'wishlist': {
        const w = data.wish as { waiting: number; due: number; saved: number } | undefined;
        return <Card key={k} title="心願清單" onClick={() => navigate('/plan?tab=wish')}>
          <div className="widget-sub">冷靜中 {w?.waiting ?? 0} 件{w?.due ? `・${w.due} 件待決定` : ''}</div>
          <div className="widget-value num" style={{ color: 'var(--success)' }}><Amount minor={w?.saved ?? 0} currency={base} tone="none" /></div>
          <div className="widget-sub">冷靜期幫你省下</div>
        </Card>;
      }
      case 'goals': {
        const g = data.goal as { g: { name: string; icon: string; targetMinor: number; currency: string }; saved: number } | undefined;
        return <Card key={k} title="存錢目標" onClick={() => navigate('/plan?tab=goal')}>
          {g ? <>
            <div className="widget-sub">{g.g.icon} {g.g.name}</div>
            <div className="bar" style={{ margin: '6px 0 4px' }}><i style={{ width: `${Math.min(100, (g.saved / g.g.targetMinor) * 100)}%`, ['--c' as string]: 'var(--success)' }} /></div>
            <div className="widget-sub num">{Math.round((g.saved / g.g.targetMinor) * 100)}%</div>
          </> : <div className="widget-sub">尚未設定</div>}
        </Card>;
      }
    }
  };
  return <WidgetStrip count={keys.length}>{keys.map(render)}</WidgetStrip>;
}

/**
 * 橫向捲動列。手機用手指滑；桌面沒有觸控，所以顯示左右箭頭（只有真的還有內容在邊界外才出現）
 * 與「第 N / 共 M 張」的提示，避免以為只有第一張卡。
 */
function WidgetStrip({ children, count }: { children: React.ReactNode; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setEdge({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, [count]);
  const go = (dir: -1 | 1) => ref.current?.scrollBy({ left: dir * Math.max(180, (ref.current?.clientWidth ?? 0) * 0.8), behavior: 'smooth' });
  return (
    <div className="widgets-wrap">
      <div className="widgets" ref={ref} aria-label="小工具">{children}</div>
      {edge.left && <button className="widgets-nav left" aria-label="上一組小工具" onClick={() => go(-1)}>‹</button>}
      {edge.right && <button className="widgets-nav right" aria-label="下一組小工具" onClick={() => go(1)}>›</button>}
    </div>
  );
}

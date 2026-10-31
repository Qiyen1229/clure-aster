/**
 * 首頁主角：只放一個大數字——這個月花了多少。
 * 下面一行輔助：結餘；若這個月有總預算，再加「今日還可花」（沒有預算就顯示日均）。
 * 看的是「選取日所在的記帳月」，翻到別的月份會跟著變。
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { computeBudgets } from '@/db/repo/plan';
import { listStatTxs } from '@/db/repo/ledger';
import { totals } from '@/domain/ledger';
import { eachDay, accountingMonth, todayKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';
import { Amount } from '@/ui/controls';

export function HomeHero({ selected }: { selected: string }) {
  const base = useSettings((s) => s.baseCurrency);
  const msd = useSettings((s) => s.monthStartDay);
  const month = accountingMonth(selected, msd);
  const today = todayKey();
  const isCurrent = today >= month.start && today <= month.end;
  const data = useLiveQuery(async () => {
    const t = totals(await listStatTxs(month.start, month.end));
    // 本月的總預算（沒有指定分類的那一個）→ 今日還可花
    const budget = isCurrent ? (await computeBudgets(today)).find((b) => !b.budget.categoryId) : undefined;
    return { t, left: budget && budget.status.todayBudget > 0 ? budget.status.todayLeft : null };
  }, [month.start, month.end, isCurrent]);

  const label = `${Number(month.start.slice(5, 7))} 月支出`;
  const days = Math.max(1, eachDay({ start: month.start, end: isCurrent ? today : month.end }).length);
  const t = data?.t;
  return (
    <section className="home-hero" aria-label="本月概況">
      <div className="hero-label">{label}</div>
      <div className="hero-amount num">
        <Amount minor={t?.expense ?? 0} currency={base} tone="none" opts={{ decimals: 0 }} />
      </div>
      <div className="hero-sub num">
        <span>結餘 <Amount minor={t?.net ?? 0} currency={base} tone={(t?.net ?? 0) >= 0 ? 'pos' : 'neg'} opts={{ decimals: 0, sign: (t?.net ?? 0) > 0 ? 'always' : undefined }} /></span>
        <i aria-hidden="true">·</i>
        {data?.left !== null && data?.left !== undefined ? (
          <span>今日還可花 <Amount minor={data.left} currency={base} tone={data.left < 0 ? 'neg' : 'none'} opts={{ decimals: 0 }} /></span>
        ) : (
          <span>日均 <Amount minor={Math.round((t?.expense ?? 0) / days)} currency={base} tone="none" opts={{ decimals: 0 }} /></span>
        )}
      </div>
    </section>
  );
}

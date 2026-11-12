/**
 * 首頁主角：只放一個大數字——這個月花了多少（或盈虧模式下當月股票損益）。
 * 下面一行輔助：結餘／勝率；若這個月有總預算，再加「今日還可花」（沒有預算就顯示日均）。
 * 看的是「選取日所在的記帳月」，翻到別的月份會跟著變。
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { computeBudgets } from '@/db/repo/plan';
import { listStatTxs } from '@/db/repo/ledger';
import { totals } from '@/domain/ledger';
import { eachDay, accountingMonth, todayKey } from '@/domain/period';
import type { MonthPnlSummary } from '@/domain/invest/pnlCalendar';
import { useSettings } from '@/stores/settings';
import { Amount } from '@/ui/controls';

interface Props {
  selected: string;
  mode?: 'ledger' | 'pnl';
  pnlSummary?: MonthPnlSummary;
}

export function HomeHero({ selected, mode = 'ledger', pnlSummary }: Props) {
  const base = useSettings((s) => s.baseCurrency);
  const msd = useSettings((s) => s.monthStartDay);
  const month = accountingMonth(selected, msd);
  const today = todayKey();
  const isCurrent = today >= month.start && today <= month.end;
  const data = useLiveQuery(async () => {
    if (mode === 'pnl') return null;
    const t = totals(await listStatTxs(month.start, month.end));
    // 本月的總預算（沒有指定分類的那一個）→ 今日還可花
    const budget = isCurrent ? (await computeBudgets(today)).find((b) => !b.budget.categoryId) : undefined;
    return { t, left: budget && budget.status.todayBudget > 0 ? budget.status.todayLeft : null };
  }, [month.start, month.end, isCurrent, mode]);

  const monthNum = Number(selected.slice(5, 7));

  // 盈虧模式：某月股票損益
  if (mode === 'pnl') {
    const pnlCurrencies = pnlSummary?.currencies ?? [];
    const hasPnl = pnlCurrencies.length > 0;
    const primary = hasPnl ? pnlCurrencies[0] : undefined;

    return (
      <section className="home-hero pnl-hero" aria-label="本月股票損益概況">
        <div className="hero-label">{monthNum} 月股票損益</div>
        <div className="hero-amount num">
          {!hasPnl ? (
            <Amount minor={0} currency={base} tone="none" opts={{ decimals: 0 }} animate />
          ) : pnlCurrencies.length === 1 ? (
            <Amount
              minor={primary!.totalPnlMinor}
              currency={primary!.currency}
              tone={primary!.totalPnlMinor > 0 ? 'pos' : primary!.totalPnlMinor < 0 ? 'neg' : 'none'}
              opts={{ decimals: 0, sign: primary!.totalPnlMinor > 0 ? 'always' : undefined }}
              animate
            />
          ) : (
            <div className="hero-pnl-dual-amounts">
              {pnlCurrencies.map((c) => {
                const isPos = c.totalPnlMinor > 0;
                const isNeg = c.totalPnlMinor < 0;
                const tone = isPos ? 'pos' : isNeg ? 'neg' : 'flat';
                const sign = isPos ? '+' : isNeg ? '-' : '';
                const val = (Math.abs(c.totalPnlMinor) / 100).toLocaleString('en-US', {
                  maximumFractionDigits: c.currency === 'TWD' ? 0 : 2,
                });
                return (
                  <span key={c.currency} className={`hero-pnl-badge ${tone}`}>
                    {c.currency === 'TWD' ? 'NT$' : 'US$'}&nbsp;{`${sign}${val}`}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div className="hero-sub num">
          {hasPnl && primary ? (
            <>
              <span>勝率 {primary.winRatePct.toFixed(0)}% ({primary.winDays}勝 {primary.lossDays}敗)</span>
              <i aria-hidden="true">·</i>
              <span>交易 {primary.tradeDays} 天 ({pnlSummary?.totalTrades ?? 0} 筆操作)</span>
            </>
          ) : (
            <span>本月尚無股票持股波動或平倉交易</span>
          )}
        </div>
      </section>
    );
  }

  // 一般記帳模式：某月支出
  const days = Math.max(1, eachDay({ start: month.start, end: isCurrent ? today : month.end }).length);
  const t = data?.t;
  const label = `${Number(month.start.slice(5, 7))} 月支出`;
  return (
    <section className="home-hero" aria-label="本月概況">
      <div className="hero-label">{label}</div>
      <div className="hero-amount num">
        <Amount minor={t?.expense ?? 0} currency={base} tone="none" opts={{ decimals: 0 }} animate />
      </div>
      <div className="hero-sub num">
        <span>結餘 <Amount minor={t?.net ?? 0} currency={base} tone={(t?.net ?? 0) >= 0 ? 'pos' : 'neg'} opts={{ decimals: 0, sign: (t?.net ?? 0) > 0 ? 'always' : undefined }} animate /></span>
        <i aria-hidden="true">·</i>
        {data?.left !== null && data?.left !== undefined ? (
          <span>今日還可花 <Amount minor={data.left} currency={base} tone="auto" opts={{ decimals: 0 }} animate /></span>
        ) : (
          <span>日均 <Amount minor={Math.round((t?.expense ?? 0) / days)} currency={base} tone="none" opts={{ decimals: 0 }} animate /></span>
        )}
      </div>
    </section>
  );
}

/** 對話裡的「花費分析」檢視卡：這期各分類花了多少（長條）、和上一期比；全部本機運算 */
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCategories } from '@/app/hooks';
import { db } from '@/db/schema';
import { analyze, pctChange } from '@/domain/reports';
import { formatMoney } from '@/domain/money';
import { accountingMonth, addMonths, todayKey, yearRange, type Range } from '@/domain/period';
import { useSettings } from '@/stores/settings';
import type { ViewSpec } from '@/domain/agent/plan';

export function SpendingView({ params, refreshKey }: { params: ViewSpec['params']; refreshKey?: string }) {
  const navigate = useNavigate();
  const { baseCurrency: base, monthStartDay: msd } = useSettings();
  const { map: cats } = useCategories();
  const kind = params.range ?? 'this_month';
  const data = useLiveQuery(async () => {
    const today = todayKey();
    const range: Range = kind === 'this_year' ? yearRange(today) : accountingMonth(kind === 'last_month' ? addMonths(today, -1) : today, msd);
    const prev: Range = kind === 'this_year' ? yearRange(addMonths(today, -12)) : accountingMonth(addMonths(range.start, -1), msd);
    const load = (r: Range) => db.transactions.where('date').between(r.start, r.end, true, true).toArray().then((rows) => rows.filter((t) => !t.deletedAt));
    const [cur, pre] = await Promise.all([load(range), load(prev)]);
    return { range, a: analyze(cur, cats, range, 'expense', today), p: analyze(pre, cats, prev, 'expense') };
  }, [kind, msd, cats, refreshKey]);
  if (!data) return <div className="skeleton" style={{ height: 120 }} />;
  const { a, p, range } = data;
  const items = [...a.byMain].sort((x, y) => y[1] - x[1]).slice(0, 6);
  const max = Math.max(1, ...items.map((x) => x[1]));
  const chg = pctChange(a.expense, p.expense);
  const label = kind === 'this_year' ? `${range.start.slice(0, 4)} 年` : kind === 'last_month' ? '上個月' : '這個月';
  return (
    <div className="view-card">
      <div className="stat-grid">
        <div className="stat"><div className="k">{label}支出</div><div className="v num">{formatMoney(a.expense, base, { decimals: 0 })}</div></div>
        <div className="stat"><div className="k">收入</div><div className="v num">{formatMoney(a.income, base, { decimals: 0 })}</div></div>
        <div className="stat"><div className="k">比上期</div><div className="v num" style={{ color: chg === null ? undefined : chg > 0 ? 'var(--danger)' : 'var(--success)' }}>{chg === null ? '—' : `${chg > 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}%`}</div></div>
      </div>
      {items.length === 0 ? <p className="muted" style={{ margin: '8px 0 0' }}>這段期間沒有支出紀錄。</p> : items.map(([id, amt]) => (
        <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontSize: '0.88rem' }}>
          <span style={{ width: 76, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cats.get(id)?.icon} {cats.get(id)?.name ?? '其他'}</span>
          <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--surface-3)', overflow: 'hidden' }}><div style={{ width: `${(amt / max) * 100}%`, height: '100%', background: cats.get(id)?.color ?? 'var(--accent)' }} /></div>
          <span className="num" style={{ minWidth: 64, textAlign: 'right' }}>{formatMoney(amt, base, { decimals: 0 })}</span>
        </div>
      ))}
      <button className="attn-link" onClick={() => navigate('/reports')}>完整報表 →</button>
    </div>
  );
}

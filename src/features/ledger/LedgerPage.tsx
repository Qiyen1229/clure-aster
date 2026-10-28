/**
 * 帳目列表：日／週／月／年／自訂區間切換，依日分組並顯示小計，
 * 虛擬捲動（@tanstack/react-virtual，1 萬筆以上流暢）。右上角打勾＝完成並回到首頁。
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { listLedger, type LedgerItem } from '@/db/repo/ledger';
import { periodRange, shiftPeriod, todayKey, type PeriodUnit } from '@/domain/period';
import { totals } from '@/domain/ledger';
import { useAccounts, useCategories, useTags } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { LedgerRow } from './LedgerRow';
import { FilterSheet, filterCount } from './FilterSheet';
import { categoryChildren, matchFilter } from '@/db/repo/plan';
import type { TxFilter } from '@/db/types';
import { statAmount } from '@/domain/ledger';

type Unit = PeriodUnit | 'custom';
type Row = { type: 'header'; date: string; expense: number; income: number } | { type: 'item'; item: LedgerItem };

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

export default function LedgerPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const settings = useSettings();
  const [unit, setUnit] = useState<Unit>(settings.ledgerUnit);
  const [anchor, setAnchor] = useState(params.get('date') ?? todayKey());
  const [custom, setCustom] = useState({ start: todayKey().slice(0, 8) + '01', end: todayKey() });
  const [keyword, setKeyword] = useState('');
  const [filter, setFilter] = useState<TxFilter>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const children = useLiveQuery(() => categoryChildren(), []);
  const accountFilter = params.get('account') ?? undefined;

  const range = unit === 'custom' ? custom : periodRange(anchor, unit, { monthStartDay: settings.monthStartDay, weekStart: settings.weekStart });
  const accounts = useAccounts(true);
  const cats = useCategories();
  const tags = useTags();
  const items = useLiveQuery(() => listLedger(range.start, range.end, accountFilter), [range.start, range.end, accountFilter]);

  const filtered = useMemo(() => {
    if (!items) return undefined;
    const k = keyword.trim().toLowerCase();
    const nf = filterCount(filter);
    const pre = !nf ? items : items.filter((it) => {
      if (it.kind === 'tx') return matchFilter(it.tx, filter, children);
      // 轉帳只套用帳戶、專案、標籤、關鍵字條件；指定類型或分類時排除
      if (filter.types?.length || filter.categoryIds?.length) return false;
      const tr = it.tr;
      if (filter.accountIds?.length && !filter.accountIds.includes(tr.fromAccountId) && !filter.accountIds.includes(tr.toAccountId)) return false;
      if (filter.projectIds?.length && !filter.projectIds.includes(tr.projectId ?? '')) return false;
      if (filter.tagIds?.length && !filter.tagIds.some((t) => tr.tagIds.includes(t))) return false;
      if (filter.keyword && !tr.note.toLowerCase().includes(filter.keyword.toLowerCase())) return false;
      return true;
    });
    if (!k) return pre;
    return pre.filter((it) => {
      if (it.kind === 'tx') {
        const c = cats.map.get(it.tx.categoryId);
        const parent = c?.parentId ? cats.map.get(c.parentId) : undefined;
        return [it.tx.note, c?.name, parent?.name, accounts.map.get(it.tx.accountId)?.name, ...it.tx.tagIds.map((t) => tags.map.get(t)?.name)]
          .some((s) => s?.toLowerCase().includes(k));
      }
      return it.tr.note.toLowerCase().includes(k) || '轉帳'.includes(k);
    });
  }, [items, keyword, cats.map, accounts.map, tags.map, filter, children]);

  // 攤平成「日期標題 + 帳目」列，供虛擬捲動
  const { rows, sum } = useMemo(() => {
    const rows: Row[] = [];
    if (!filtered) return { rows, sum: totals([]) };
    let cur: Extract<Row, { type: 'header' }> | null = null;
    for (const it of filtered) {
      if (!cur || cur.date !== it.date) {
        cur = { type: 'header', date: it.date, expense: 0, income: 0 };
        rows.push(cur);
      }
      if (it.kind === 'tx' && it.tx.type !== 'adjust' && !it.tx.excludeFromStats) {
        if (it.tx.type === 'income') cur.income += statAmount(it.tx);
        else cur.expense += statAmount(it.tx);
      } else if (it.kind === 'transfer' && it.tr.feeMinor) {
        cur.expense += it.tr.feeMinor;
      }
      rows.push({ type: 'item', item: it });
    }
    const sum = rows.reduce((s, r) => (r.type === 'header' ? { ...s, expense: s.expense + r.expense, income: s.income + r.income } : { ...s, count: s.count + 1 }),
      { expense: 0, income: 0, net: 0, count: 0 });
    sum.net = sum.income - sum.expense;
    return { rows, sum };
  }, [filtered]);

  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (i) => (rows[i].type === 'header' ? 40 : 72),
    overscan: 10,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  const rangeLabel = (() => {
    if (unit === 'day') return range.start.replace(/-/g, '/');
    if (unit === 'year') return `${range.start.slice(0, 4)} 年`;
    if (unit === 'month' && settings.monthStartDay === 1) return `${range.start.slice(0, 4)} 年 ${Number(range.start.slice(5, 7))} 月`;
    return `${range.start.slice(5).replace('-', '/')} – ${range.end.slice(5).replace('-', '/')}`;
  })();

  return (
    <main className="page">
      <header className="topbar">
        <div style={{ width: 44 }} />
        <h1>{accountFilter ? accounts.map.get(accountFilter)?.name ?? '帳目' : '帳目明細'}</h1>
        <button className="icon-btn" aria-label="完成，回到首頁" onClick={() => navigate('/')}><Icon name="check" /></button>
      </header>

      <Segmented<Unit> value={unit} ariaLabel="期間"
        onChange={(u) => { setUnit(u); if (u !== 'custom') settings.set('ledgerUnit', u); }}
        options={[{ value: 'day', label: '日' }, { value: 'week', label: '週' }, { value: 'month', label: '月' }, { value: 'year', label: '年' }, { value: 'custom', label: '自訂' }]} />

      {unit === 'custom' ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
          <input type="date" className="input" value={custom.start} max={custom.end} onChange={(e) => setCustom((c) => ({ ...c, start: e.target.value }))} aria-label="開始日期" />
          <span className="muted">–</span>
          <input type="date" className="input" value={custom.end} min={custom.start} onChange={(e) => setCustom((c) => ({ ...c, end: e.target.value }))} aria-label="結束日期" />
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0' }}>
          <button className="icon-btn plain" aria-label="上一期" onClick={() => setAnchor((a) => shiftPeriod(a, unit, -1))}><Icon name="chevronL" /></button>
          <button className="num" style={{ fontWeight: 600, minHeight: 44 }} onClick={() => setAnchor(todayKey())}>{rangeLabel}</button>
          <button className="icon-btn plain" aria-label="下一期" onClick={() => setAnchor((a) => shiftPeriod(a, unit, 1))}><Icon name="chevronR" /></button>
        </div>
      )}

      <div className="card glass">
        <div className="stat-grid">
          <div><div className="muted" style={{ fontSize: '0.75rem' }}>支出</div><div className="num" style={{ fontWeight: 700 }}><Amount minor={sum.expense} currency={settings.baseCurrency} tone="neg" animate /></div></div>
          <div><div className="muted" style={{ fontSize: '0.75rem' }}>收入</div><div className="num" style={{ fontWeight: 700 }}><Amount minor={sum.income} currency={settings.baseCurrency} tone="pos" animate /></div></div>
          <div><div className="muted" style={{ fontSize: '0.75rem' }}>結餘</div><div className="num" style={{ fontWeight: 700 }}><Amount minor={sum.net} currency={settings.baseCurrency} tone="auto" animate /></div></div>
        </div>
      </div>

      <div style={{ position: 'relative', marginBottom: 8, display: 'flex', gap: 8 }}>
        <button className="icon-btn" aria-label={`進階篩選${filterCount(filter) ? `（${filterCount(filter)} 項）` : ''}`} onClick={() => setFilterOpen(true)}
          style={filterCount(filter) ? { background: 'var(--accent)', color: 'var(--on-accent)', order: 2 } : { order: 2 }}>
          <Icon name="filter" />
        </button>
        <input className="input" type="search" placeholder="搜尋備註、分類、帳戶、標籤" value={keyword} onChange={(e) => setKeyword(e.target.value)} aria-label="篩選" style={{ paddingLeft: 40 }} />
        <span style={{ position: 'absolute', left: 12, top: 12 }} className="faint"><Icon name="search" size={20} /></span>
      </div>
      <FilterSheet open={filterOpen} onClose={() => setFilterOpen(false)} value={filter} onChange={setFilter} />

      {!filtered || cats.loading ? <SkeletonRows /> : rows.length === 0 ? (
        <EmptyState emoji="📭" title={keyword ? '找不到符合的帳目' : '這段期間沒有帳目'} text={keyword ? '換個關鍵字試試看。' : '切換期間，或點 ＋ 開始記帳。'} />
      ) : (
        <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const r = rows[v.index];
            return (
              <div key={v.key} data-index={v.index} ref={virtualizer.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${v.start - virtualizer.options.scrollMargin}px)` }}>
                {r.type === 'header' ? (
                  <div className="group-header">
                    <span><b className="num">{r.date.slice(5).replace('-', '/')}</b>週{WEEKDAY[new Date(r.date + 'T00:00').getDay()]}</span>
                    <span className="num">
                      {r.income > 0 && <><Amount minor={r.income} currency={settings.baseCurrency} tone="pos" /> · </>}
                      <Amount minor={-r.expense} currency={settings.baseCurrency} tone="none" />
                    </span>
                  </div>
                ) : (
                  <LedgerRow item={r.item} cats={cats.map} accounts={accounts.map} tags={tags.map}
                    showDate={unit === 'year'} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {accountFilter && (
        <p className="disclaimer"><button className="accent" onClick={() => { params.delete('account'); setParams(params); }}>顯示全部帳戶</button></p>
      )}
    </main>
  );
}

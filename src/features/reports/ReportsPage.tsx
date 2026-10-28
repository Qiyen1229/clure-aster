/**
 * 報表（Tab 4）：
 *  - 期間：月（依記帳月起算日）／年／自訂；篩選：帳戶、專案、標籤、幣別
 *  - 指標：支出、收入、結餘、儲蓄率、收支比、日均、最大單筆、最常花錢的星期與時段
 *  - 圖表：分類環形圖（點主分類下鑽子分類、點子分類看明細）、趨勢（月：每日；年：每月）、
 *          近 12 個月收支、淨資產成長曲線、星期／時段分佈
 *  - 比較：本期 vs 上期、本期 vs 去年同期
 *  - 年度回顧、列印／PDF
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import { AiInsightsCard } from '../ai/AiInsights';
import { AUTH_ENABLED } from '@/stores/auth';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Transaction } from '@/db/types';
import { analyze, pctChange } from '@/domain/reports';
import { accountingMonth, addMonths, todayKey, yearRange, type Range } from '@/domain/period';
import { formatMoney } from '@/domain/money';
import { statAmount } from '@/domain/ledger';
import { netWorthSeries } from '@/services/networth';
import { useAccounts, useCategories, useProjects, useTags } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { LedgerRow } from '../ledger/LedgerRow';
import { chartTheme } from './chart-theme';

const EChart = lazy(() => import('./EChart'));
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

interface RFilter { accountIds: string[]; projectIds: string[]; tagIds: string[]; currencies: string[] }

async function loadTxs(range: Range, f: RFilter): Promise<Transaction[]> {
  const all = await db.transactions.where('date').between(range.start, range.end, true, true).toArray();
  return all.filter((t) => !t.deletedAt
    && (!f.accountIds.length || f.accountIds.includes(t.accountId))
    && (!f.projectIds.length || f.projectIds.includes(t.projectId ?? ''))
    && (!f.tagIds.length || f.tagIds.some((x) => t.tagIds.includes(x)))
    && (!f.currencies.length || f.currencies.includes(t.currency)));
}

function shiftRange(unit: 'month' | 'year', r: Range, n: number, msd: number): Range {
  return unit === 'year' ? yearRange(addMonths(r.start, 12 * n)) : accountingMonth(addMonths(r.start, n), msd);
}

export default function ReportsPage() {
  const navigate = useNavigate();
  const { baseCurrency: base, monthStartDay } = useSettings();
  const [unit, setUnit] = useState<'month' | 'year' | 'custom'>('month');
  const [anchor, setAnchor] = useState(todayKey());
  const [custom, setCustom] = useState<Range>({ start: addMonths(todayKey(), -3), end: todayKey() });
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [drill, setDrill] = useState<string | null>(null);
  const [filter, setFilter] = useState<RFilter>({ accountIds: [], projectIds: [], tagIds: [], currencies: [] });
  const [filterOpen, setFilterOpen] = useState(false);
  const [detail, setDetail] = useState<{ title: string; txs: Transaction[] } | null>(null);
  const cats = useCategories();
  const accounts = useAccounts(true);
  const tags = useTags();

  const range: Range = unit === 'custom' ? custom : unit === 'year' ? yearRange(anchor) : accountingMonth(anchor, monthStartDay);
  const prev = unit === 'custom' ? null : shiftRange(unit, range, -1, monthStartDay);
  const lastYear = unit === 'month' ? accountingMonth(addMonths(range.start, -12), monthStartDay) : null;
  const trendRange: Range = { start: addMonths(range.end, -11).slice(0, 8) + '01', end: range.end };
  const fkey = JSON.stringify(filter);
  const tick = useLiveQuery(() => db.transactions.count(), []);

  const data = useLiveQuery(async () => {
    const [cur, p, ly, trend] = await Promise.all([
      loadTxs(range, filter), prev ? loadTxs(prev, filter) : Promise.resolve([]), lastYear ? loadTxs(lastYear, filter) : Promise.resolve([]), loadTxs(trendRange, filter),
    ]);
    return { cur, p, ly, trend };
  }, [range.start, range.end, fkey, tick]);
  const nw = useLiveQuery(() => netWorthSeries(12), [tick]);

  const a = useMemo(() => (data ? analyze(data.cur, cats.map, range, kind, todayKey()) : null), [data, cats.map, kind, range.start, range.end]); // eslint-disable-line react-hooks/exhaustive-deps
  const ap = useMemo(() => (data && prev ? analyze(data.p, cats.map, prev, kind) : null), [data, cats.map, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const aly = useMemo(() => (data && lastYear ? analyze(data.ly, cats.map, lastYear, kind) : null), [data, cats.map, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const at = useMemo(() => (data ? analyze(data.trend, cats.map, trendRange, kind) : null), [data, cats.map, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = unit === 'year' ? `${range.start.slice(0, 4)} 年` : unit === 'month' && monthStartDay === 1
    ? `${range.start.slice(0, 4)} 年 ${Number(range.start.slice(5, 7))} 月` : `${range.start.replace(/-/g, '/')} – ${range.end.slice(5).replace('-', '/')}`;
  const fcount = filter.accountIds.length + filter.projectIds.length + filter.tagIds.length + filter.currencies.length;
  const fmt = (v: number) => formatMoney(v, base, { compact: true });
  const t = chartTheme();

  // ── 環形圖（可下鑽） ──
  const pie = useMemo(() => {
    if (!a) return null;
    const src = drill ? a.bySub.get(drill) ?? new Map() : a.byMain;
    const items = [...src].sort((x, y) => y[1] - x[1]);
    return {
      items,
      option: {
        tooltip: { trigger: 'item', valueFormatter: (v: number) => formatMoney(v, base) },
        series: [{
          type: 'pie', radius: ['55%', '82%'], avoidLabelOverlap: true, itemStyle: { borderRadius: 6, borderColor: t.surface, borderWidth: 2 },
          label: { show: false }, emphasis: { scale: true, scaleSize: 6 },
          data: items.map(([id, v]) => ({ name: cats.map.get(id)?.name ?? '未分類', value: v, id, itemStyle: { color: cats.map.get(id)?.color } })),
        }],
      },
    };
  }, [a, drill, cats.map, base]); // eslint-disable-line react-hooks/exhaustive-deps

  const openCategory = (catId: string, isMain: boolean) => {
    if (!data) return;
    const ids = isMain ? new Set([catId, ...cats.all.filter((c) => c.parentId === catId).map((c) => c.id)]) : new Set([catId]);
    setDetail({ title: cats.map.get(catId)?.name ?? '明細', txs: data.cur.filter((x) => ids.has(x.categoryId) && x.type !== 'adjust' && !x.excludeFromStats) });
  };

  // ── 趨勢（月：每日；年／自訂：每月） ──
  const trend = useMemo(() => {
    if (!a) return null;
    const keys: string[] = [];
    if (unit === 'month') for (let d = range.start; d <= range.end; d = addDays1(d)) keys.push(d);
    else for (let m = range.start.slice(0, 7); m <= range.end.slice(0, 7); m = addMonths(m + '-01', 1).slice(0, 7)) keys.push(m);
    const src = unit === 'month' ? a.byDay : a.byMonth;
    return {
      keys,
      option: {
        grid: { left: 8, right: 8, top: 24, bottom: 4, containLabel: true },
        legend: { top: 0, right: 0, textStyle: { color: t.text2 }, itemWidth: 10, itemHeight: 10 },
        tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatMoney(v, base) },
        xAxis: { type: 'category', data: keys.map((k) => (unit === 'month' ? String(Number(k.slice(8))) : `${Number(k.slice(5, 7))}月`)), axisLine: { lineStyle: { color: t.sep } }, axisLabel: { color: t.text3 } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: t.sep, type: 'dashed' } }, axisLabel: { color: t.text3, formatter: (v: number) => fmt(v).replace('$', '') } },
        series: [
          { name: '支出', type: 'bar', data: keys.map((k) => src.get(k)?.expense ?? 0), itemStyle: { color: t.neg, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 18 },
          { name: '收入', type: 'bar', data: keys.map((k) => src.get(k)?.income ?? 0), itemStyle: { color: t.pos, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 18 },
        ],
      },
    };
  }, [a, unit, range.start, range.end, base]); // eslint-disable-line react-hooks/exhaustive-deps

  const year12 = useMemo(() => {
    if (!at) return null;
    const keys: string[] = [];
    for (let i = 11; i >= 0; i--) keys.push(addMonths(range.end, -i).slice(0, 7));
    return {
      keys,
      option: {
        grid: { left: 8, right: 8, top: 24, bottom: 4, containLabel: true },
        legend: { top: 0, right: 0, textStyle: { color: t.text2 }, itemWidth: 10, itemHeight: 10 },
        tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatMoney(v, base) },
        xAxis: { type: 'category', data: keys.map((k) => `${Number(k.slice(5))}月`), axisLabel: { color: t.text3 }, axisLine: { lineStyle: { color: t.sep } } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: t.sep, type: 'dashed' } }, axisLabel: { color: t.text3, formatter: (v: number) => fmt(v).replace('$', '') } },
        series: [
          { name: '支出', type: 'bar', data: keys.map((k) => at.byMonth.get(k)?.expense ?? 0), itemStyle: { color: t.neg, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 16 },
          { name: '收入', type: 'bar', data: keys.map((k) => at.byMonth.get(k)?.income ?? 0), itemStyle: { color: t.pos, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 16 },
          { name: '結餘', type: 'line', smooth: true, symbol: 'circle', symbolSize: 5, data: keys.map((k) => (at.byMonth.get(k)?.income ?? 0) - (at.byMonth.get(k)?.expense ?? 0)), itemStyle: { color: t.accent }, lineStyle: { width: 2 } },
        ],
      },
    };
  }, [at, range.end, base]); // eslint-disable-line react-hooks/exhaustive-deps

  const nwOption = useMemo(() => nw && nw.length > 1 ? {
    grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatMoney(v, base) },
    xAxis: { type: 'category', boundaryGap: false, data: nw.map((p) => p.date.slice(2, 7).replace('-', '/')), axisLabel: { color: t.text3 }, axisLine: { lineStyle: { color: t.sep } } },
    yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: t.sep, type: 'dashed' } }, axisLabel: { color: t.text3, formatter: (v: number) => fmt(v).replace('$', '') } },
    series: [
      { name: '淨資產', type: 'line', smooth: true, data: nw.map((p) => p.netWorth), symbol: 'none', lineStyle: { width: 2.5, color: t.accent }, areaStyle: { color: t.accent, opacity: 0.12 } },
      { name: '投資市值', type: 'line', smooth: true, data: nw.map((p) => p.invest), symbol: 'none', lineStyle: { width: 1.5, color: t.pos, type: 'dashed' } },
    ],
  } : null, [nw, base]); // eslint-disable-line react-hooks/exhaustive-deps

  const distOption = (values: number[], labels: string[]) => ({
    grid: { left: 4, right: 4, top: 8, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatMoney(v, base) },
    xAxis: { type: 'category', data: labels, axisLabel: { color: t.text3, fontSize: 10 }, axisLine: { lineStyle: { color: t.sep } } },
    yAxis: { type: 'value', show: false },
    series: [{ type: 'bar', data: values.map((v) => ({ value: v, itemStyle: { color: v === Math.max(...values) && v > 0 ? t.accent : t.text3, borderRadius: [3, 3, 0, 0] } })), barMaxWidth: 14 }],
  });

  const Change = ({ cur, prevV, invert }: { cur: number; prevV: number; invert?: boolean }) => {
    const c = pctChange(cur, prevV);
    if (c === null) return <span className="muted">—</span>;
    if (Math.abs(c) < 0.05) return <span className="muted">持平</span>;
    const good = invert ? c < 0 : c > 0;
    return <span style={{ color: good ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>{c > 0 ? '▲' : '▼'} {Math.abs(c).toFixed(1)}%</span>;
  };

  return (
    <main className="page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
        <h1 className="large-title" style={{ margin: '4px 4px 8px' }}>報表</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="icon-btn" aria-label={`篩選${fcount ? `（${fcount}）` : ''}`} onClick={() => setFilterOpen(true)} style={fcount ? { background: 'var(--accent)', color: 'var(--on-accent)' } : undefined}><Icon name="filter" /></button>
          <button className="icon-btn" aria-label="列印或儲存 PDF" onClick={() => {
            // 列印沿用目前篩選的帳戶／專案／標籤／幣別（可在列印頁再調整）
            const q = new URLSearchParams({ start: range.start, end: range.end });
            if (filter.accountIds.length) q.set('accounts', filter.accountIds.join(','));
            if (filter.projectIds.length) q.set('projects', filter.projectIds.join(','));
            if (filter.tagIds.length) q.set('tags', filter.tagIds.join(','));
            if (filter.currencies.length) q.set('currencies', filter.currencies.join(','));
            navigate(`/reports/print?${q}`);
          }}><Icon name="download" /></button>
        </div>
      </div>
      <Segmented value={unit} onChange={(u) => { setUnit(u); setDrill(null); }} options={[{ value: 'month', label: '月' }, { value: 'year', label: '年' }, { value: 'custom', label: '自訂' }]} ariaLabel="期間" />
      {unit === 'custom' ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
          <input type="date" className="input" value={custom.start} max={custom.end} onChange={(e) => setCustom((c) => ({ ...c, start: e.target.value }))} aria-label="開始" />
          <span className="muted">–</span>
          <input type="date" className="input" value={custom.end} min={custom.start} onChange={(e) => setCustom((c) => ({ ...c, end: e.target.value }))} aria-label="結束" />
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 0' }}>
          <button className="icon-btn plain" aria-label="上一期" onClick={() => { setAnchor(shiftRange(unit, range, -1, monthStartDay).start); setDrill(null); }}><Icon name="chevronL" /></button>
          <button className="num" style={{ fontWeight: 600, minHeight: 44 }} onClick={() => setAnchor(todayKey())}>{label}</button>
          <button className="icon-btn plain" aria-label="下一期" onClick={() => { setAnchor(shiftRange(unit, range, 1, monthStartDay).start); setDrill(null); }}><Icon name="chevronR" /></button>
        </div>
      )}

      {!a || !data ? <SkeletonRows n={5} /> : a.count === 0 ? (
        <EmptyState emoji="📊" title="這段期間沒有資料" text={fcount ? '試著調整或清除篩選條件。' : '記幾筆帳之後，這裡會出現完整的圖表分析。'} />
      ) : (
        <>
          <section className="card glass" aria-label="摘要">
            <div className="stat-grid">
              <div className="stat"><div className="k">支出</div><div className="v num"><Amount minor={a.expense} currency={base} tone="neg" animate /></div></div>
              <div className="stat"><div className="k">收入</div><div className="v num"><Amount minor={a.income} currency={base} tone="pos" animate /></div></div>
              <div className="stat"><div className="k">結餘</div><div className="v num"><Amount minor={a.net} currency={base} tone="auto" animate /></div></div>
              <div className="stat"><div className="k">儲蓄率</div><div className="v num">{a.savingRate === null ? '—' : `${a.savingRate.toFixed(1)}%`}</div></div>
              <div className="stat"><div className="k">收支比</div><div className="v num">{a.ratio === null ? '—' : `${a.ratio.toFixed(0)}%`}</div></div>
              <div className="stat"><div className="k">日均花費</div><div className="v num"><Amount minor={a.dailyAvg} currency={base} tone="none" opts={{ decimals: 0 }} /></div></div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 12, fontSize: '0.85rem' }} className="muted">
              {a.maxTx && <button className="accent" onClick={() => setDetail({ title: '最大單筆', txs: [a.maxTx!] })}>最大單筆 {formatMoney(statAmount(a.maxTx), base)}（{a.maxTx.note || cats.map.get(a.maxTx.categoryId)?.name}）</button>}
              {a.expense > 0 && <span>最常花錢：週{WEEK[a.topWeekday]}・{a.topHour}:00 時段</span>}
              <span>{a.count} 筆</span>
            </div>
          </section>

          {(ap || aly) && (
            <section className="card" aria-label="比較">
              <div style={{ fontWeight: 600, marginBottom: 8 }}>比較</div>
              <div className="list" style={{ boxShadow: 'none', margin: 0 }}>
                {ap && <div className="row" style={{ padding: '8px 0' }}><span className="row-main">{unit === 'year' ? '比去年' : '比上個月'}支出</span><span className="num muted" style={{ marginRight: 8 }}>{fmt(ap.expense)}</span><Change cur={a.expense} prevV={ap.expense} invert /></div>}
                {ap && <div className="row" style={{ padding: '8px 0' }}><span className="row-main">{unit === 'year' ? '比去年' : '比上個月'}收入</span><span className="num muted" style={{ marginRight: 8 }}>{fmt(ap.income)}</span><Change cur={a.income} prevV={ap.income} /></div>}
                {aly && <div className="row" style={{ padding: '8px 0' }}><span className="row-main">比去年同月支出</span><span className="num muted" style={{ marginRight: 8 }}>{fmt(aly.expense)}</span><Change cur={a.expense} prevV={aly.expense} invert /></div>}
              </div>
            </section>
          )}

          {AUTH_ENABLED && unit === 'month' && <AiInsightsCard unit="month" anchor={anchor} />}

          <section className="card" aria-label="分類佔比">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              {drill ? (
                <button className="btn small secondary" onClick={() => setDrill(null)}><Icon name="chevronL" size={16} />{cats.map.get(drill)?.name}</button>
              ) : <span style={{ fontWeight: 600, flex: 1 }}>分類佔比</span>}
              <div style={{ width: 140, marginLeft: 'auto' }}>
                <Segmented value={kind} onChange={(k) => { setKind(k); setDrill(null); }} options={[{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }]} ariaLabel="收支" />
              </div>
            </div>
            {pie && pie.items.length > 0 ? (
              <>
                <div style={{ position: 'relative' }}>
                  <Suspense fallback={<div className="skeleton" style={{ height: 220 }} />}>
                    <EChart option={pie.option} height={220} ariaLabel="分類環形圖"
                      onClick={(p) => { const id = pie.items[p.dataIndex]?.[0]; if (!id) return; if (!drill && (a.bySub.get(id)?.size ?? 0) > 1) setDrill(id); else openCategory(id, !drill); }} />
                  </Suspense>
                  <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', textAlign: 'center' }}>
                    <div><div className="muted" style={{ fontSize: '0.75rem' }}>{drill ? cats.map.get(drill)?.name : kind === 'expense' ? '總支出' : '總收入'}</div>
                      <div className="num" style={{ fontWeight: 700 }}>{fmt(pie.items.reduce((s, [, v]) => s + v, 0))}</div></div>
                  </div>
                </div>
                <div className="list" style={{ boxShadow: 'none', margin: '8px 0 0' }}>
                  {pie.items.map(([id, v]) => {
                    const c = cats.map.get(id);
                    const total = pie.items.reduce((s, [, x]) => s + x, 0);
                    const hasSub = !drill && (a.bySub.get(id)?.size ?? 0) > 1;
                    return (
                      <button key={id} className="row" style={{ padding: '8px 0' }} onClick={() => (hasSub ? setDrill(id) : openCategory(id, !drill))}>
                        <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true">{c?.icon}</span>
                        <span className="row-main">{c?.name ?? '未分類'} <span className="muted num" style={{ fontSize: '0.8rem' }}>{((v / total) * 100).toFixed(1)}%</span></span>
                        <Amount minor={v} currency={base} tone="none" className="num" />
                        <Icon name="chevronR" className="row-chev" />
                      </button>
                    );
                  })}
                </div>
              </>
            ) : <p className="muted" style={{ textAlign: 'center' }}>沒有{kind === 'expense' ? '支出' : '收入'}資料</p>}
          </section>

          {trend && unit !== 'custom' && (
            <section className="card" aria-label="趨勢">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{unit === 'month' ? '每日收支' : '每月收支'}</div>
              <Suspense fallback={<div className="skeleton" style={{ height: 200 }} />}>
                <EChart option={trend.option} height={200} ariaLabel="收支趨勢長條圖" onClick={(p) => {
                  const k = trend.keys[p.dataIndex];
                  if (unit === 'year') { setUnit('month'); setAnchor(`${k}-${String(Math.max(1, monthStartDay)).padStart(2, '0')}`); }
                  else setDetail({ title: k, txs: data.cur.filter((x) => x.date === k && x.type !== 'adjust') });
                }} />
              </Suspense>
            </section>
          )}

          {year12 && (
            <section className="card" aria-label="近 12 個月">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>近 12 個月</div>
              <Suspense fallback={<div className="skeleton" style={{ height: 220 }} />}>
                <EChart option={year12.option} height={220} ariaLabel="近 12 個月收支" onClick={(p) => {
                  const k = year12.keys[p.dataIndex];
                  setUnit('month'); setAnchor(`${k}-${String(Math.max(1, monthStartDay)).padStart(2, '0')}`);
                }} />
              </Suspense>
            </section>
          )}

          {nwOption && (
            <section className="card" aria-label="淨資產成長">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 600 }}>淨資產成長</span>
                {nw && <span className="num muted" style={{ fontSize: '0.85rem' }}>{fmt(nw[nw.length - 1].netWorth)}（<Change cur={nw[nw.length - 1].netWorth} prevV={nw[0].netWorth} />）</span>}
              </div>
              <Suspense fallback={<div className="skeleton" style={{ height: 200 }} />}>
                <EChart option={nwOption} height={200} ariaLabel="淨資產成長曲線" />
              </Suspense>
              <p className="muted" style={{ fontSize: '0.72rem', margin: 0 }}>早於每日快照的月份由帳目倒推帳戶餘額；投資市值取當時快照。</p>
            </section>
          )}

          {a.expense > 0 && (
            <section className="card" aria-label="花費分佈">
              <div style={{ fontWeight: 600 }}>花費最多的星期幾／時段</div>
              <Suspense fallback={<div className="skeleton" style={{ height: 120 }} />}>
                <EChart option={distOption(a.byWeekday, WEEK.map((w) => `週${w}`))} height={120} ariaLabel="星期花費分佈" />
                <EChart option={distOption(a.byHour, Array.from({ length: 24 }, (_, i) => String(i)))} height={120} ariaLabel="時段花費分佈" />
              </Suspense>
              {a.topNotes.length > 0 && (
                <>
                  <div style={{ fontWeight: 600, margin: '8px 0 4px' }}>花最多的項目</div>
                  {a.topNotes.map((n) => (
                    <div key={n.note} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', padding: '4px 0' }}>
                      <span>{n.note} <span className="muted">×{n.count}</span></span><span className="num">{formatMoney(n.amount, base)}</span>
                    </div>
                  ))}
                </>
              )}
            </section>
          )}

          <button className="card" style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12, background: 'linear-gradient(135deg, #5E5CE6, #BF5AF2 55%, #FF375F)', color: '#fff' }}
            onClick={() => navigate(`/reports/review/${range.start.slice(0, 4)}`)}>
            <span style={{ fontSize: 34 }} aria-hidden="true">🎁</span>
            <span className="row-main"><b>{range.start.slice(0, 4)} 年度回顧</b><br /><span style={{ opacity: 0.85, fontSize: '0.85rem' }}>看看這一年的錢都花到哪裡去了</span></span>
            <Icon name="chevronR" />
          </button>
          <div className="list" style={{ marginTop: 12 }}>
            <button className="row" onClick={() => navigate('/reports/summary?unit=week')}>
              <span aria-hidden="true" style={{ fontSize: 22 }}>📊</span>
              <span className="row-main"><span className="row-title">週報／月報</span><span className="row-sub" style={{ display: 'block' }}>上週、上個月花了多少，和前一期比哪裡變多了</span></span>
              <Icon name="chevronR" className="row-chev" />
            </button>
            <button className="row" onClick={() => navigate('/reports/cashflow')}>
              <span aria-hidden="true" style={{ fontSize: 22 }}>🔮</span>
              <span className="row-main"><span className="row-title">現金流預測</span><span className="row-sub" style={{ display: 'block' }}>未來 30～180 天的錢夠不夠用、哪天哪個帳戶會不夠付卡費</span></span>
              <Icon name="chevronR" className="row-chev" />
            </button>
            <button className="row" onClick={() => navigate('/reports/fire')}>
              <span aria-hidden="true" style={{ fontSize: 22 }}>🏝️</span>
              <span className="row-main"><span className="row-title">財務自由試算</span><span className="row-sub" style={{ display: 'block' }}>依目前淨資產與儲蓄，模擬幾歲可以不用工作</span></span>
              <Icon name="chevronR" className="row-chev" />
            </button>
            <button className="row" onClick={() => navigate('/reports/tax')}>
              <span aria-hidden="true" style={{ fontSize: 22 }}>🧾</span>
              <span className="row-main"><span className="row-title">投資稅務彙總</span><span className="row-sub" style={{ display: 'block' }}>股利合併／分開計稅比較、海外所得與最低稅負</span></span>
              <Icon name="chevronR" className="row-chev" />
            </button>
          </div>
        </>
      )}

      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="報表篩選"
        left={<button className="accent" style={{ minHeight: 44 }} onClick={() => setFilter({ accountIds: [], projectIds: [], tagIds: [], currencies: [] })}>清除</button>}
        right={<button className="accent" style={{ minHeight: 44, fontWeight: 600 }} onClick={() => setFilterOpen(false)}>完成</button>}>
        <ReportFilter value={filter} onChange={setFilter} />
      </Sheet>
      <Sheet open={!!detail} onClose={() => setDetail(null)} title={detail?.title} full>
        {detail && (detail.txs.length ? detail.txs.sort((x, y) => (x.date < y.date ? 1 : -1)).map((tx) => (
          <LedgerRow key={tx.id} item={{ kind: 'tx', id: tx.id, date: tx.date, ts: tx.ts, tx }} cats={cats.map} accounts={accounts.map} tags={tags.map} showDate />
        )) : <EmptyState emoji="🫥" title="沒有帳目" />)}
      </Sheet>
    </main>
  );
}

function addDays1(d: string) {
  const x = new Date(`${d}T00:00:00`);
  x.setDate(x.getDate() + 1);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function ReportFilter({ value, onChange }: { value: RFilter; onChange: (f: RFilter) => void }) {
  const accounts = useAccounts(true);
  const projects = useProjects();
  const tags = useTags();
  const currencies = useLiveQuery(async () => [...new Set((await db.transactions.toArray()).map((t) => t.currency))], []) ?? [];
  const toggle = (k: keyof RFilter, id: string) => onChange({ ...value, [k]: value[k].includes(id) ? value[k].filter((x) => x !== id) : [...value[k], id] });
  const group = (title: string, k: keyof RFilter, items: { id: string; label: string }[]) => items.length > 0 && (
    <>
      <div className="section-title">{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map((it) => <button key={it.id} className="pill" aria-pressed={value[k].includes(it.id)} onClick={() => toggle(k, it.id)}>{it.label}</button>)}
      </div>
    </>
  );
  return (
    <>
      {group('帳戶', 'accountIds', accounts.list.map((a) => ({ id: a.id, label: `${a.icon} ${a.name}` })))}
      {group('專案', 'projectIds', projects.list.map((p) => ({ id: p.id, label: `${p.icon} ${p.name}` })))}
      {group('標籤', 'tagIds', tags.list.map((t) => ({ id: t.id, label: t.name })))}
      {group('幣別', 'currencies', currencies.map((c) => ({ id: c, label: c })))}
    </>
  );
}


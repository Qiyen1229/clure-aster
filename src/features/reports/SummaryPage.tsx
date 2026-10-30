/**
 * 週報／月報：這期花了多少、和上一期比、白話重點、分類變化、最大一筆。
 * 網址：/reports/summary?unit=week|month&date=YYYY-MM-DD（沒給日期就是上週／上個月）
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAccounts, useCategories, useTags } from '@/app/hooks';
import type { PeriodSummary } from '@/domain/summary';
import { formatMoney } from '@/domain/money';
import { addDays, todayKey } from '@/domain/period';
import { lastCompleted, loadSummary, summaryRange, summaryTitle, type SummaryUnit } from '@/services/summary';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { db } from '@/db/schema';
import type { Transaction } from '@/db/types';
import { countsInStats } from '@/domain/ledger';
import { EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { LedgerRow } from '../ledger/LedgerRow';
import { AiInsightsCard } from '../ai/AiInsights';
import { AUTH_ENABLED } from '@/stores/auth';

export default function SummaryPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const unit: SummaryUnit = params.get('unit') === 'month' ? 'month' : 'week';
  const today = todayKey();
  const anchor = params.get('date') && /^\d{4}-\d{2}-\d{2}$/.test(params.get('date')!) ? params.get('date')! : lastCompleted(unit, today);
  const base = useSettings((s) => s.baseCurrency);
  const { map: cats } = useCategories();
  const accounts = useAccounts(true);
  const tags = useTags();
  const [sum, setSum] = useState<PeriodSummary | null>(null);
  const [detail, setDetail] = useState<{ title: string; txs: Transaction[] } | null>(null);
  const money = (v: number) => formatMoney(v, base, { decimals: 0 });

  useEffect(() => {
    let alive = true;
    setSum(null);
    void loadSummary(unit, anchor, today).then((s) => alive && setSum(s));
    return () => { alive = false; };
  }, [unit, anchor, today]);

  const { range, prevRange } = summaryRange(unit, anchor);
  const go = (date: string, u = unit) => setParams({ unit: u, date }, { replace: true });
  const isCurrent = range.end >= today;
  const prevLabel = unit === 'week' ? '前一週' : '前一個月';
  const max = Math.max(1, ...(sum?.categories.map((c) => Math.max(c.amount, c.prev)) ?? [1]));

  const openKindDetail = async (kind: 'expense' | 'income' | 'all') => {
    const all = await db.transactions.where('date').between(range.start, range.end, true, true).toArray();
    const txs = all.filter((x) => countsInStats(x) && (kind === 'all' || x.type === kind));
    const title = kind === 'expense' ? `支出明細（${txs.length} 筆）` : kind === 'income' ? `收入明細（${txs.length} 筆）` : `記帳明細（${txs.length} 筆）`;
    setDetail({ title, txs });
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>{unit === 'week' ? '週報' : '月報'}</h1>
        <div style={{ width: 44 }} />
      </header>
      <Segmented value={unit} onChange={(u) => go(lastCompleted(u, today), u)} ariaLabel="摘要週期" options={[{ value: 'week', label: '週報' }, { value: 'month', label: '月報' }]} />
      <div className="sum-nav">
        <button className="icon-btn" aria-label="上一期" onClick={() => go(prevRange.start)}><Icon name="chevronL" /></button>
        <b className="num">{summaryTitle(unit, range)}{isCurrent ? '（進行中）' : ''}</b>
        <button className="icon-btn" aria-label="下一期" disabled={isCurrent} onClick={() => go(addDays(range.end, 1))}><Icon name="chevronR" /></button>
      </div>

      {!sum ? <SkeletonRows n={4} /> : (
        <>
          <section className="card glass sum-hero">
            <button type="button" className="stat clickable" style={{ padding: '8px 12px', background: 'transparent', textAlign: 'center' }} onClick={() => openKindDetail('expense')} aria-label="查看支出明細">
              <div className="k muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span>支出</span>
                <Icon name="chevronR" size={12} />
              </div>
              <div className="v num">{money(sum.expense)}</div>
            </button>
            {sum.changePct !== null && (
              <span className={`sum-chip ${sum.changePct <= 0 ? 'good' : 'bad'}`}>
                {sum.changePct <= 0 ? '↓' : '↑'} {Math.abs(Math.round(sum.changePct))}% vs {prevLabel}
              </span>
            )}
            <div className="stat-grid" style={{ marginTop: 12 }}>
              <button type="button" className="stat clickable" onClick={() => openKindDetail('income')} aria-label="查看收入明細">
                <div className="k" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>收入</span>
                  <Icon name="chevronR" size={12} className="muted" />
                </div>
                <div className="v num">{money(sum.income)}</div>
              </button>
              <div className="stat"><div className="k">日均支出</div><div className="v num">{money(sum.dailyAvg)}</div></div>
              <button type="button" className="stat clickable" onClick={() => openKindDetail('all')} aria-label="查看記帳明細">
                <div className="k" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>記帳</span>
                  <Icon name="chevronR" size={12} className="muted" />
                </div>
                <div className="v num">{sum.count} 筆</div>
              </button>
            </div>
          </section>

          {sum.insights.length > 0 && (
            <section className="card">
              <b>重點</b>
              <ul className="sum-insights">{sum.insights.map((t) => <li key={t}>{t}</li>)}</ul>
            </section>
          )}

          {AUTH_ENABLED && <AiInsightsCard unit={unit} anchor={anchor} />}

          {sum.categories.length > 0 && (
            <>
              <div className="section-title">分類（和{prevLabel}比）</div>
              <div className="list">
                {sum.categories.slice(0, 8).map((c) => {
                  const cat = cats.get(c.id);
                  return (
                    <div key={c.id} className="row with-icon">
                      <span className="cat-icon sm" style={{ ['--c' as string]: cat?.color }} aria-hidden="true">{cat?.icon ?? '✨'}</span>
                      <span className="row-main">
                        <span className="row-title" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span>{cat?.name ?? '其他'}</span><span className="num">{money(c.amount)}</span>
                        </span>
                        <span className="sum-bar"><i style={{ width: `${(c.amount / max) * 100}%`, background: cat?.color }} /><i className="prev" style={{ width: `${(c.prev / max) * 100}%` }} /></span>
                        <span className="row-sub" style={{ display: 'block' }}>
                          {c.prev === 0 ? `${prevLabel}沒有` : c.delta === 0 ? '持平' : `${c.delta > 0 ? '多' : '少'} ${money(Math.abs(c.delta))}`}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {sum.biggest && (
            <>
              <div className="section-title">最大一筆</div>
              <div className="list">
                <button className="row with-icon" onClick={() => useUI.getState().editTx(sum.biggest!.id)}>
                  <span className="cat-icon sm" style={{ ['--c' as string]: cats.get(sum.biggest.categoryId)?.color }} aria-hidden="true">{cats.get(sum.biggest.categoryId)?.icon ?? '✨'}</span>
                  <span className="row-main"><span className="row-title">{sum.biggest.note || cats.get(sum.biggest.categoryId)?.name}</span><span className="row-sub">{sum.biggest.date}</span></span>
                  <span className="num neg">{formatMoney(sum.biggest.amountMinor, sum.biggest.currency)}</span>
                </button>
              </div>
            </>
          )}
          <p className="muted" style={{ fontSize: '0.78rem', margin: '10px 8px' }}>
            {unit === 'week' ? '每週第一天' : '每月第一天'}早上 9 點會提醒你看{unit === 'week' ? '週報' : '月報'}，可在「設定 → 通知與提醒」關閉。
          </p>
        </>
      )}

      <Sheet open={!!detail} onClose={() => setDetail(null)} title={detail?.title} full>
        {detail && (detail.txs.length ? detail.txs.sort((x, y) => (x.date < y.date ? 1 : -1)).map((tx) => (
          <LedgerRow key={tx.id} item={{ kind: 'tx', id: tx.id, date: tx.date, ts: tx.ts, tx }} cats={cats} accounts={accounts.map} tags={tags.map} showDate />
        )) : <EmptyState emoji="🫥" title="沒有帳目" />)}
      </Sheet>
    </main>
  );
}

/**
 * 預算：月／週／自訂週期、總額或分類／專案預算、結轉、警示門檻。
 * 卡片顯示進度條、剩餘金額、剩餘天數、今日可用（Moze 式動態每日額度）、推估期末花費、超支警示。
 */
import { AiMark } from '@/ui/Icon';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Budget } from '@/db/types';
import { computeBudgets, createSuggestedBudgets, deleteBudget, saveBudget, suggestBudgets, type BudgetView } from '@/db/repo/plan';
import { forecastBudget } from '@/domain/budgetwarn';
import { formatMoney, fromMinor, toMinor } from '@/domain/money';
import { WhyToggle } from '../insights/WhyToggle';
import { evaluate } from '@/domain/calc-expr';
import { todayKey } from '@/domain/period';
import { useCategories, useProjects } from '@/app/hooks';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { AmountField, CategoryField, DateField, SelectField, SwitchField, TextField } from '@/ui/form';
import { Sheet } from '@/ui/Sheet';
import { SectionHead } from './PlanPage';

export default function BudgetSection() {
  const navigate = useNavigate();
  const [edit, setEdit] = useState<Budget | 'new' | null>(null);
  const monthStartDay = useSettings((s) => s.monthStartDay);
  const tick = useLiveQuery(() => db.transactions.count(), []);
  const budgets = useLiveQuery(() => db.budgets.toArray(), []);
  const views = useLiveQuery(() => computeBudgets(), [tick, budgets, monthStartDay]);
  const base = useSettings((s) => s.baseCurrency);

  /** 依過去 3 個完整月份的實際支出：建立每月總預算與花費最多的 5 個分類（可復原） */
  const suggestAll = async () => {
    const sug = await suggestBudgets();
    if (!sug.total) { useUI.getState().showSnack({ text: '還沒有足夠的歷史帳目（需要至少一個完整月份的支出）' }); return; }
    const ids = await createSuggestedBudgets(sug, base);
    if (!ids.length) { useUI.getState().showSnack({ text: '這些預算都已經有了' }); return; }
    snackUndo(`已依過去 ${sug.monthsUsed} 個月的花費建立 ${ids.length} 個預算`, async () => { for (const id of ids) await deleteBudget(id); });
  };

  return (
    <>
      <SectionHead title="預算" onAdd={() => setEdit('new')} />
      {AUTH_ENABLED && (
        <button className="card" style={{ width: '100%', textAlign: 'left', marginBottom: 8 }} onClick={() => navigate('/ai?tool=budget')}>
          <span className="row-title"><AiMark /> 讓 AI 建議下個月預算</span>
          <span className="row-sub" style={{ display: 'block', whiteSpace: 'normal' }}>依過去花費與固定支出，算出總預算與每天的日常預算</span>
        </button>
      )}
      {!views ? <SkeletonRows /> : views.length === 0 ? (
        <EmptyState emoji="🎯" title="還沒有預算" text="先設定一個「每月總預算」，再為容易超支的分類（飲食、購物）各設一個。有過去幾個月的帳目，可以直接依實際花費建立。"
          action={(
            <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button className="btn small" onClick={() => void suggestAll()}>依過去花費建立</button>
              <button className="btn small secondary" onClick={() => setEdit('new')}>自己設定</button>
            </span>
          )} />
      ) : views.map((v) => (
        <div key={v.budget.id}>
          <BudgetCard v={v} onEdit={() => setEdit(v.budget)} />
          <BudgetWarnNote v={v} />
        </div>
      ))}
      {budgets && budgets.some((b) => !b.active) && (
        <>
          <div className="section-title">已停用</div>
          <div className="list">
            {budgets.filter((b) => !b.active).map((b) => (
              <button key={b.id} className="row" onClick={() => setEdit(b)}><span className="row-main">{b.name}</span><span className="muted">停用中</span></button>
            ))}
          </div>
        </>
      )}
      <BudgetSheet open={edit !== null} budget={edit === 'new' ? undefined : edit ?? undefined} onClose={() => setEdit(null)} />
    </>
  );
}

/** 預算預警：照目前花法會超支時，在卡片下方顯示一行提示與白話說明（本機規則計算，不使用 AI） */
function BudgetWarnNote({ v }: { v: BudgetView }) {
  const on = useSettings((s) => !!s.insights?.budgetWarn);
  if (!on) return null;
  const w = forecastBudget({ id: v.budget.id, name: v.budget.name, limit: v.status.limit, spent: v.status.spent, period: v.period, today: todayKey(), projected: v.projection.projected }, (m) => formatMoney(m, v.budget.currency, { decimals: 0 }));
  if (!w) return null;
  return (
    <div className="insight-card card" style={{ ['--lv' as string]: w.level === 'over' ? 'var(--danger)' : 'var(--warning)', marginTop: -4 }}>
      <div className="insight-title">{w.level === 'over' ? '⚠️' : '🔔'} {w.title}</div>
      <WhyToggle id={w.id} why={w.why} tip={w.tip} />
    </div>
  );
}

function BudgetCard({ v, onEdit }: { v: BudgetView; onEdit: () => void }) {
  const { status: s, budget: b } = v;
  const cats = useCategories();
  const color = s.level === 'over' ? 'var(--danger)' : s.level === 'warn' ? 'var(--warning)' : 'var(--accent)';
  const cat = b.categoryId ? cats.map.get(b.categoryId) : undefined;
  return (
    <button className="card" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={onEdit}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span className="cat-icon sm" style={{ ['--c' as string]: cat?.color }} aria-hidden="true">{cat?.icon ?? '🎯'}</span>
        <div className="row-main">
          <div style={{ fontWeight: 600 }}>{b.name}</div>
          <div className="row-sub">{v.period.start.slice(5).replace('-', '/')} – {v.period.end.slice(5).replace('-', '/')} · 剩 {s.daysLeft} 天{b.rollover && v.carryIn ? ` · 結轉 ${v.carryIn > 0 ? '+' : ''}${fromMinor(v.carryIn, b.currency).toFixed(0)}` : ''}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <Amount minor={s.remaining} currency={b.currency} tone={s.remaining < 0 ? 'neg' : 'none'} className="num" />
          <div className="row-sub">{s.remaining < 0 ? '已超支' : '剩餘'}</div>
        </div>
      </div>
      <div className="bar" role="progressbar" aria-valuenow={Math.round(s.pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${b.name} 使用率`}>
        <i style={{ width: `${Math.min(100, s.pct)}%`, ['--c' as string]: color }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: '0.8rem' }} className="muted num">
        <span>已用 <Amount minor={s.spent} currency={b.currency} tone="none" /> / <Amount minor={s.limit} currency={b.currency} tone="none" />（{Math.round(s.pct)}%）</span>

      </div>
      {s.todayBudget > 0 || s.spentToday > 0 ? (
        <div className="today-allow">
          <div>
            <div className="muted" style={{ fontSize: '0.75rem' }}>今日還可花</div>
            <div className="num" style={{ fontSize: '1.5rem', fontWeight: 800, color: s.todayLeft > 0 ? 'var(--danger)' : s.todayLeft < 0 ? 'var(--success)' : 'var(--text)' }}>
              <Amount minor={s.todayLeft} currency={b.currency} tone="none" opts={{ decimals: 0 }} />
            </div>
          </div>
          <div className="muted num" style={{ fontSize: '0.75rem', textAlign: 'right' }}>
            今日額度 <Amount minor={s.todayBudget} currency={b.currency} tone="none" opts={{ decimals: 0 }} /><br />
            今天已花 <Amount minor={s.spentToday} currency={b.currency} tone="none" opts={{ decimals: 0 }} />
          </div>
        </div>
      ) : null}
      {s.level !== 'over' && s.spent > 0 && s.daysLeft > 0 && (
        <p style={{ margin: '8px 0 0', fontSize: '0.8rem', color: v.projection.projected > s.limit ? 'var(--warning)' : 'var(--text-2)' }}>
          {v.projection.projected > s.limit ? '⚠️ ' : ''}{v.projection.basis === 'history' ? '依過去幾期的花費節奏' : '依目前速度'}，期末預估{' '}
          <Amount minor={v.projection.projected} currency={b.currency} tone="none" opts={{ decimals: 0 }} />
          {v.projection.projected > s.limit ? '，可能超支' : `，預計剩 ${fromMinor(s.limit - v.projection.projected, b.currency).toFixed(0)}`}
        </p>
      )}
      {s.level === 'over' && <p style={{ margin: '8px 0 0', fontSize: '0.8rem', color: 'var(--danger)' }}>已超出預算 <Amount minor={-s.remaining} currency={b.currency} tone="none" /></p>}
    </button>
  );
}

function BudgetSheet({ open, budget, onClose }: { open: boolean; budget?: Budget; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={budget ? '編輯預算' : '新增預算'}>
      {open && <BudgetForm key={budget?.id ?? 'new'} budget={budget} onClose={onClose} />}
    </Sheet>
  );
}

function BudgetForm({ budget, onClose }: { budget?: Budget; onClose: () => void }) {
  const base = useSettings((s) => s.baseCurrency);
  const cats = useCategories();
  const projects = useProjects();
  const [name, setName] = useState(budget?.name ?? '每月總預算');
  const [periodType, setPeriodType] = useState<Budget['periodType']>(budget?.periodType ?? 'month');
  const [customDays, setCustomDays] = useState(String(budget?.customDays ?? 14));
  const [startDate, setStartDate] = useState(budget?.startDate ?? todayKey().slice(0, 8) + '01');
  const [amount, setAmount] = useState(budget ? fromMinor(budget.amountMinor, budget.currency).toString() : '');
  const [categoryId, setCategoryId] = useState(budget?.categoryId ?? '');
  const [projectId, setProjectId] = useState(budget?.projectId ?? '');
  const [rollover, setRollover] = useState(budget?.rollover ?? false);
  const [alert, setAlert] = useState(String(budget?.alertPercents?.[0] ?? 80));
  const [active, setActive] = useState(budget ? !!budget.active : true);
  // 依過去 3 個完整月份的支出給建議（只有「總預算」或大分類有；子分類沒有）
  const sug = useLiveQuery(() => suggestBudgets(), []);
  const hint = !sug ? null : categoryId === '' ? sug.total : (cats.map.get(categoryId)?.parentId ? null : sug.byCategory.find((x) => x.categoryId === categoryId)?.suggestion ?? null);

  const save = async () => {
    const v = evaluate(amount || '0');
    if (!v || v.lte(0)) { useUI.getState().showSnack({ text: '請輸入預算金額' }); return; }
    await saveBudget({
      name: name.trim() || '預算', periodType, customDays: periodType === 'custom' ? Math.max(1, Number(customDays) || 14) : undefined,
      startDate, amountMinor: toMinor(v, base), currency: base, categoryId, projectId, rollover,
      alertPercents: [Math.min(100, Math.max(1, Number(alert) || 80))], active: active ? 1 : 0,
    }, budget?.id);
    onClose();
  };

  return (
    <>
      <Segmented value={periodType} onChange={setPeriodType} ariaLabel="週期"
        options={[{ value: 'month', label: '每月' }, { value: 'week', label: '每週' }, { value: 'custom', label: '自訂天數' }]} />
      <div className="list" style={{ marginTop: 12 }}>
        <TextField label="名稱" value={name} onChange={setName} />
        <AmountField label="每期額度" value={amount} onChange={setAmount} currency={base} />
        <CategoryField label="分類" value={categoryId} onChange={(id) => { setCategoryId(id); if (id && (!budget && (name === '每月總預算' || !name))) setName(`${cats.map.get(id)?.name ?? ''}預算`); }}
          categories={cats.all} kind="expense" allowEmpty emptyLabel="全部支出（總預算）" />
        <SelectField label="專案" value={projectId} onChange={setProjectId}
          options={[{ value: '', label: '不限' }, ...projects.list.map((p) => ({ value: p.id, label: p.name }))]} />
        {periodType === 'custom' && <TextField label="每期天數" value={customDays} onChange={(v) => setCustomDays(v.replace(/\D/g, ''))} inputMode="numeric" />}
        <DateField label={periodType === 'custom' ? '起始日' : '開始計算'} value={startDate} onChange={setStartDate} />
        <SwitchField label="結轉" sub="上期剩餘（或超支）滾入下期" checked={rollover} onChange={setRollover} />
        <TextField label="警示門檻 %" value={alert} onChange={(v) => setAlert(v.replace(/\D/g, ''))} inputMode="numeric" />
        {budget && <SwitchField label="啟用" checked={active} onChange={setActive} />}
      </div>
      {hint && periodType === 'month' && (
        <p className="muted" style={{ fontSize: '0.82rem', margin: '0 4px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>過去 {hint.months.length} 個月平均每月 {fromMinor(hint.avgMinor, base).toFixed(0)}，建議 {fromMinor(hint.suggestedMinor, base).toFixed(0)}</span>
          <button className="pill" onClick={() => setAmount(fromMinor(hint.suggestedMinor, base).toString())}>套用建議</button>
        </p>
      )}
      <button className="btn" onClick={() => void save()}>儲存</button>
      {budget && (
        <button className="btn danger" style={{ marginTop: 10 }} onClick={async () => {
          if (!window.confirm(`刪除「${budget.name}」？帳目不受影響。`)) return;
          await deleteBudget(budget.id);
          onClose();
        }}>刪除預算</button>
      )}
    </>
  );
}

/**
 * 預算：月／週／自訂週期、總額或分類／專案預算、結轉、警示門檻。
 * 卡片顯示進度條、剩餘金額、剩餘天數、今日可用（Moze 式動態每日額度）、推估期末花費、超支警示。
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Budget } from '@/db/types';
import { computeBudgets, deleteBudget, saveBudget, type BudgetView } from '@/db/repo/plan';
import { fromMinor, toMinor } from '@/domain/money';
import { evaluate } from '@/domain/calc-expr';
import { todayKey } from '@/domain/period';
import { useCategories, useProjects } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { AmountField, CategoryField, DateField, SelectField, SwitchField, TextField } from '@/ui/form';
import { Sheet } from '@/ui/Sheet';
import { SectionHead } from './PlanPage';

export default function BudgetSection() {
  const [edit, setEdit] = useState<Budget | 'new' | null>(null);
  const monthStartDay = useSettings((s) => s.monthStartDay);
  const tick = useLiveQuery(() => db.transactions.count(), []);
  const budgets = useLiveQuery(() => db.budgets.toArray(), []);
  const views = useLiveQuery(() => computeBudgets(), [tick, budgets, monthStartDay]);

  return (
    <>
      <SectionHead title="預算" onAdd={() => setEdit('new')} />
      {!views ? <SkeletonRows /> : views.length === 0 ? (
        <EmptyState emoji="🎯" title="還沒有預算" text="先設定一個「每月總預算」，再為容易超支的分類（飲食、購物）各設一個。"
          action={<button className="btn small" onClick={() => setEdit('new')}>建立預算</button>} />
      ) : views.map((v) => <BudgetCard key={v.budget.id} v={v} onEdit={() => setEdit(v.budget)} />)}
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
            <div className="num" style={{ fontSize: '1.5rem', fontWeight: 800, color: s.todayLeft < 0 ? 'var(--danger)' : 'var(--accent-text)' }}>
              <Amount minor={s.todayLeft} currency={b.currency} tone="none" opts={{ decimals: 0 }} />
            </div>
          </div>
          <div className="muted num" style={{ fontSize: '0.75rem', textAlign: 'right' }}>
            今日額度 <Amount minor={s.todayBudget} currency={b.currency} tone="none" opts={{ decimals: 0 }} /><br />
            今天已花 <Amount minor={s.spentToday} currency={b.currency} tone="none" opts={{ decimals: 0 }} />
          </div>
        </div>
      ) : null}
      {s.level !== 'over' && s.projected > s.limit && s.spent > 0 && (
        <p style={{ margin: '8px 0 0', fontSize: '0.8rem', color: 'var(--warning)' }}>⚠️ 依目前速度，期末預估花費 <Amount minor={s.projected} currency={b.currency} tone="none" opts={{ decimals: 0 }} />，可能超支</p>
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

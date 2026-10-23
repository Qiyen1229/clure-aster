/**
 * 存錢目標：目標金額、期限、連結帳戶（以帳戶餘額計算進度）或手動存入；環形進度、每月需存。
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Goal } from '@/db/types';
import { goalSaved, saveGoal } from '@/db/repo/plan';
import { goalProgress } from '@/domain/goal';
import { fromMinor, toMinor } from '@/domain/money';
import { evaluate } from '@/domain/calc-expr';
import { todayKey } from '@/domain/period';
import { useAccounts } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Amount, EmptyState, SkeletonRows } from '@/ui/controls';
import { AmountField, CurrencyField, DateField, Ring, TextField } from '@/ui/form';
import { Sheet } from '@/ui/Sheet';
import { SectionHead } from './PlanPage';

const ICONS = ['🐷', '🏝️', '🏠', '🚗', '💍', '🎓', '💻', '🛟', '👶', '📷', '🎸', '✈️'];

export default function GoalSection() {
  const [edit, setEdit] = useState<Goal | 'new' | null>(null);
  const goals = useLiveQuery(() => db.goals.toArray(), []);
  const balances = useLiveQuery(() => db.accounts.toArray(), []);
  const saved = useLiveQuery(async () => {
    const m = new Map<string, number>();
    for (const g of goals ?? []) m.set(g.id, await goalSaved(g));
    return m;
  }, [goals, balances]);

  return (
    <>
      <SectionHead title="存錢目標" onAdd={() => setEdit('new')} />
      {!goals ? <SkeletonRows /> : goals.length === 0 ? (
        <EmptyState emoji="🐷" title="還沒有存錢目標" text="旅行基金、緊急預備金、頭期款…設定金額與期限，自動算出每月要存多少。"
          action={<button className="btn small" onClick={() => setEdit('new')}>建立目標</button>} />
      ) : (
        goals.sort((a, b) => (a.status === 'active' ? -1 : 1) - (b.status === 'active' ? -1 : 1)).map((g) => {
          const s = saved?.get(g.id) ?? 0;
          const p = goalProgress(g.targetMinor, s, todayKey(), g.deadline);
          return (
            <button key={g.id} className="card" style={{ display: 'flex', gap: 16, alignItems: 'center', width: '100%', textAlign: 'left', opacity: g.status === 'archived' ? 0.5 : 1 }} onClick={() => setEdit(g)}>
              <Ring pct={p.pct} size={72} color={p.done ? 'var(--success)' : g.color}>{p.done ? '🎉' : `${Math.round(p.pct)}%`}</Ring>
              <div className="row-main">
                <div style={{ fontWeight: 600 }}>{g.icon} {g.name}</div>
                <div className="row-sub num"><Amount minor={s} currency={g.currency} tone="none" /> / <Amount minor={g.targetMinor} currency={g.currency} tone="none" /></div>
                {p.done ? <div className="row-sub" style={{ color: 'var(--success)' }}>已達成！</div> :
                  p.monthly !== null ? (
                    <div className="row-sub" style={{ color: p.overdue ? 'var(--danger)' : undefined }}>
                      {p.overdue ? '已過期限・' : ''}每月需存 <b style={{ color: 'var(--text)' }}><Amount minor={p.monthly} currency={g.currency} tone="none" /></b>（剩 {p.monthsLeft} 個月）
                    </div>
                  ) : <div className="row-sub">還差 <Amount minor={p.left} currency={g.currency} tone="none" /></div>}
              </div>
            </button>
          );
        })
      )}
      <Sheet open={edit !== null} onClose={() => setEdit(null)} title={edit && edit !== 'new' ? '編輯目標' : '新增目標'}>
        {edit !== null && <GoalForm key={edit === 'new' ? 'new' : edit.id} goal={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
      </Sheet>
    </>
  );
}

function GoalForm({ goal, onClose }: { goal?: Goal; onClose: () => void }) {
  const base = useSettings((s) => s.baseCurrency);
  const accounts = useAccounts();
  const [name, setName] = useState(goal?.name ?? '');
  const [icon, setIcon] = useState(goal?.icon ?? '🐷');
  const [currency, setCurrency] = useState(goal?.currency ?? base);
  const [target, setTarget] = useState(goal ? fromMinor(goal.targetMinor, goal.currency).toString() : '');
  const [deadline, setDeadline] = useState(goal?.deadline ?? '');
  const [linked, setLinked] = useState<string[]>(goal?.linkedAccountIds ?? []);
  const [manual, setManual] = useState(goal ? fromMinor(goal.manualSavedMinor, goal.currency).toString() : '0');
  const [deposit, setDeposit] = useState('');

  const save = async () => {
    const t = evaluate(target || '0');
    if (!name.trim() || !t || t.lte(0)) { useUI.getState().showSnack({ text: '請輸入名稱與目標金額' }); return; }
    const m = evaluate(manual || '0') ?? 0;
    const d = deposit ? evaluate(deposit) ?? 0 : 0;
    await saveGoal({
      name: name.trim(), icon, color: '#30D158', targetMinor: toMinor(t, currency), currency, deadline: deadline || undefined,
      linkedAccountIds: linked, manualSavedMinor: toMinor(m, currency) + toMinor(d, currency), status: goal?.status ?? 'active', start: goal?.start ?? todayKey(),
    }, goal?.id);
    onClose();
  };

  return (
    <>
      <div className="swatches" role="radiogroup" aria-label="圖示">
        {ICONS.map((i) => <button key={i} className="pill" aria-pressed={icon === i} onClick={() => setIcon(i)} aria-label={i}>{i}</button>)}
      </div>
      <div className="list">
        <TextField label="名稱" value={name} onChange={setName} placeholder="例如：日本旅遊基金" />
        <CurrencyField value={currency} onChange={setCurrency} />
        <AmountField label="目標金額" value={target} onChange={setTarget} currency={currency} />
        <DateField label="期限" value={deadline} onChange={setDeadline} min={todayKey()} />
        <AmountField label="手動已存" value={manual} onChange={setManual} currency={currency} />
        {goal && <AmountField label="本次存入" value={deposit} onChange={setDeposit} currency={currency} placeholder="選填，累加到手動已存" />}
      </div>
      <div className="section-title">連結帳戶（以餘額計入進度）</div>
      <div className="sub-row" style={{ flexWrap: 'wrap' }}>
        {accounts.list.filter((a) => !a.isLiability).map((a) => (
          <button key={a.id} className="pill" aria-pressed={linked.includes(a.id)} onClick={() => setLinked((s) => (s.includes(a.id) ? s.filter((x) => x !== a.id) : [...s, a.id]))}>{a.icon} {a.name}</button>
        ))}
      </div>
      <button className="btn" onClick={() => void save()}>儲存</button>
      {goal && (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn secondary" onClick={async () => { await saveGoal({ ...goal, status: goal.status === 'archived' ? 'active' : 'archived' }, goal.id); onClose(); }}>{goal.status === 'archived' ? '取消封存' : '封存'}</button>
          <button className="btn danger" onClick={async () => { if (window.confirm('刪除這個目標？')) { await db.goals.delete(goal.id); onClose(); } }}>刪除</button>
        </div>
      )}
    </>
  );
}

/**
 * 分期付款：期數、年利率、手續費（首期／分攤）自動拆成每期帳目；顯示剩餘期數與未來負擔、攤還表。
 */
import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Installment } from '@/db/types';
import { addInstallment, deleteInstallment } from '@/db/repo/plan';
import { buildSchedule, periodTotal, remaining } from '@/domain/installment';
import { formatMoney, toMinor } from '@/domain/money';
import { evaluate } from '@/domain/calc-expr';
import { addMonths, todayKey } from '@/domain/period';
import { useAccounts } from '@/app/hooks';
import { useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { AccountField, AmountField, CategoryField, DateField, SelectField, TextField } from '@/ui/form';
import { Sheet } from '@/ui/Sheet';
import { useCategories } from '@/app/hooks';
import { SectionHead } from './PlanPage';

export default function InstallmentSection() {
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<Installment | null>(null);
  const [status, setStatus] = useState<'active' | 'done'>('active');
  const list = useLiveQuery(() => db.installments.toArray(), []);
  const accounts = useAccounts(true);
  const shown = (list ?? []).filter((i) => i.status === status);
  const future = (list ?? []).filter((i) => i.status === 'active').reduce((a, i) => a + remaining(i.schedule).futureMinor, 0);
  const nextMonth = addMonths(todayKey(), 1).slice(0, 7);
  const nextMonthDue = (list ?? []).flatMap((i) => i.schedule.filter((s) => !s.transactionId && s.date.startsWith(nextMonth))).reduce((a, s) => a + periodTotal(s), 0);

  return (
    <>
      <SectionHead title="分期付款" onAdd={() => setAdding(true)} />
      {(list?.length ?? 0) > 0 && (
        <div className="card glass">
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(2,1fr)' }}>
            <div><div className="muted" style={{ fontSize: '0.75rem' }}>未來總負擔</div><div className="num" style={{ fontWeight: 700 }}><Amount minor={future} currency="TWD" tone="neg" /></div></div>
            <div><div className="muted" style={{ fontSize: '0.75rem' }}>下個月應繳</div><div className="num" style={{ fontWeight: 700 }}><Amount minor={nextMonthDue} currency="TWD" tone="none" /></div></div>
          </div>
        </div>
      )}
      <Segmented value={status} onChange={setStatus} options={[{ value: 'active', label: '進行中' }, { value: 'done', label: '已繳清' }]} ariaLabel="狀態" />
      {!list ? <SkeletonRows /> : shown.length === 0 ? (
        <EmptyState emoji="💳" title={status === 'active' ? '沒有進行中的分期' : '沒有已繳清的分期'} text="信用卡分期購物，輸入總額與期數，每期到期時自動記入信用卡帳戶。"
          action={status === 'active' ? <button className="btn small" onClick={() => setAdding(true)}>新增分期</button> : undefined} />
      ) : (
        <div className="list" style={{ marginTop: 12 }}>
          {shown.map((i) => {
            const r = remaining(i.schedule);
            const paid = i.periods - r.periodsLeft;
            return (
              <button key={i.id} className="row" onClick={() => setView(i)}>
                <div className="row-main">
                  <div className="row-title">{i.name}</div>
                  <div className="row-sub">{accounts.map.get(i.accountId)?.name ?? '?'} · 已繳 {paid}/{i.periods} 期{Number(i.aprDec) ? ` · 年利率 ${i.aprDec}%` : ' · 0 利率'}</div>
                  <div className="bar" style={{ marginTop: 6 }}><i style={{ width: `${(paid / i.periods) * 100}%` }} /></div>
                </div>
                <div className="row-end">
                  <Amount minor={r.futureMinor} currency={i.currency} tone="none" className="num" />
                  <div className="row-sub">剩 {r.periodsLeft} 期</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
      <Sheet open={adding} onClose={() => setAdding(false)} title="新增分期" full>
        {adding && <InstallmentForm onClose={() => setAdding(false)} />}
      </Sheet>
      <Sheet open={!!view} onClose={() => setView(null)} title={view?.name}>
        {view && (
          <>
            <ScheduleTable inst={view} />
            <button className="btn danger" style={{ marginTop: 12 }} onClick={async () => {
              if (!window.confirm('刪除這筆分期？已入帳的期數會保留在帳目中，未到期的期數將取消。')) return;
              await deleteInstallment(view.id);
              setView(null);
            }}>刪除分期</button>
          </>
        )}
      </Sheet>
    </>
  );
}

function ScheduleTable({ inst }: { inst: Pick<Installment, 'schedule' | 'currency'> }) {
  const total = inst.schedule.reduce((a, s) => a + periodTotal(s), 0);
  const interest = inst.schedule.reduce((a, s) => a + s.interestMinor + s.feeMinor, 0);
  return (
    <>
      <p className="muted num" style={{ fontSize: '0.85rem' }}>總繳 {formatMoney(total, inst.currency)}，其中利息＋手續費 {formatMoney(interest, inst.currency)}</p>
      <div className="list">
        {inst.schedule.map((s) => (
          <div key={s.no} className="row" style={{ minHeight: 44 }}>
            <span className="num" style={{ width: 36 }}>{s.no}</span>
            <span className="num muted" style={{ flex: 1 }}>{s.date}</span>
            <span className="num" style={{ fontSize: '0.8rem' }} title="本金＋利息＋手續費">{formatMoney(periodTotal(s), inst.currency)}</span>
            <span style={{ width: 22, textAlign: 'center' }}>{s.transactionId ? '✓' : ''}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function InstallmentForm({ onClose }: { onClose: () => void }) {
  const accounts = useAccounts();
  const cats = useCategories();
  const cards = accounts.list.filter((a) => a.type === 'credit');
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState(cards[0]?.id ?? accounts.list[0]?.id ?? '');
  const acc = accounts.map.get(accountId);
  const currency = acc?.currency ?? 'TWD';
  const [categoryId, setCategoryId] = useState('exp-shopping');
  const [principal, setPrincipal] = useState('');
  const [periods, setPeriods] = useState('12');
  const [apr, setApr] = useState('0');
  const [fee, setFee] = useState('');
  const [feeMode, setFeeMode] = useState<'first' | 'spread'>('first');
  const [firstDate, setFirstDate] = useState(todayKey());

  const preview = useMemo(() => {
    try {
      const p = evaluate(principal || '0');
      if (!p || p.lte(0)) return null;
      return buildSchedule({ principalMinor: toMinor(p, currency), periods: Math.max(1, Number(periods) || 1), aprDec: apr || '0', feeMinor: fee ? toMinor(evaluate(fee) ?? 0, currency) : 0, feeMode, firstDate });
    } catch { return null; }
  }, [principal, periods, apr, fee, feeMode, firstDate, currency]);

  const save = async () => {
    if (!name.trim() || !preview || !accountId) { useUI.getState().showSnack({ text: '請填寫名稱、帳戶與金額' }); return; }
    await addInstallment({
      name: name.trim(), accountId, categoryId, principalMinor: toMinor(evaluate(principal)!, currency), currency,
      periods: Math.max(1, Number(periods) || 1), aprDec: apr || '0', feeMinor: fee ? toMinor(evaluate(fee) ?? 0, currency) : 0, feeMode, firstDate,
    });
    useUI.getState().showSnack({ text: '已建立分期，已到期的期數已入帳' });
    onClose();
  };

  return (
    <>
      <div className="list">
        <TextField label="名稱" value={name} onChange={setName} placeholder="例如：iPhone 17 Pro" />
        <AccountField label="付款帳戶" value={accountId} onChange={setAccountId} accounts={accounts.list} />
        <CategoryField value={categoryId} onChange={setCategoryId} categories={cats.all} kind="expense" />
        <AmountField label="分期總額" value={principal} onChange={setPrincipal} currency={currency} />
        <SelectField label="期數" value={periods} onChange={setPeriods} options={['3', '6', '10', '12', '18', '24', '30', '36', '48', '60'].map((p) => ({ value: p, label: `${p} 期` }))} />
        <AmountField label="年利率 %" value={apr} onChange={setApr} placeholder="0" />
        <AmountField label="手續費" value={fee} onChange={setFee} currency={currency} placeholder="0" />
        <SelectField label="手續費收取" value={feeMode} onChange={setFeeMode} options={[{ value: 'first', label: '第一期一次收' }, { value: 'spread', label: '平均分攤每期' }]} />
        <DateField label="第一期日期" value={firstDate} onChange={setFirstDate} />
      </div>
      {preview && <><div className="section-title">攤還預覽</div><ScheduleTable inst={{ schedule: preview, currency }} /></>}
      <button className="btn" onClick={() => void save()} style={{ marginTop: 8 }}>建立分期</button>
    </>
  );
}

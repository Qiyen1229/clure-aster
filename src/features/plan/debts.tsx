/**
 * 應收／應付帳款（含分帳、代墊、借出、借入）：依人顯示淨額、明細、結清（可同時記錄到帳戶）、手動新增。
 */
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Debt } from '@/db/types';
import { addDebts, findOrCreatePerson, settleDebt, unsettleDebt } from '@/db/repo/plan';
import { netByPerson } from '@/domain/debt';
import { toMinor } from '@/domain/money';
import { evaluate } from '@/domain/calc-expr';
import { todayKey } from '@/domain/period';
import { useAccounts, useCategories } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { AccountField, AmountField, CategoryField, DateField, TextField } from '@/ui/form';
import { Sheet } from '@/ui/Sheet';
import { SectionHead } from './PlanPage';

export default function DebtSection() {
  const debts = useLiveQuery(() => db.debts.toArray(), []);
  const people = useLiveQuery(() => db.people.toArray(), []);
  const [adding, setAdding] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
  const base = useSettings((s) => s.baseCurrency);
  const net = useMemo(() => netByPerson(debts ?? []), [debts]);
  const pmap = new Map((people ?? []).map((p) => [p.id, p]));

  let owedToMe = 0, iOwe = 0;
  for (const byCur of net.values()) {
    const v = byCur.get(base) ?? 0;
    if (v > 0) owedToMe += v; else iOwe += -v;
  }
  const rows = [...net.entries()].filter(([, m]) => [...m.values()].some((v) => v !== 0));

  return (
    <>
      <SectionHead title="應收／應付帳款" onAdd={() => setAdding(true)} />
      <div className="card glass">
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(2,1fr)' }}>
          <div><div className="muted" style={{ fontSize: '0.75rem' }}>應收（別人欠我）</div><div className="num" style={{ fontWeight: 700 }}><Amount minor={owedToMe} currency={base} tone="pos" /></div></div>
          <div><div className="muted" style={{ fontSize: '0.75rem' }}>應付（我欠別人）</div><div className="num" style={{ fontWeight: 700 }}><Amount minor={iOwe} currency={base} tone="neg" /></div></div>
        </div>
      </div>
      {!debts ? <SkeletonRows /> : rows.length === 0 ? (
        <EmptyState emoji="🤝" title="沒有未結清的應收／應付" text="記一筆時選「應收」或「應付」記錄借出、借入；支出時點「分帳」可拆給朋友。" />
      ) : (
        <div className="list">
          {rows.map(([pid, byCur]) => (
            <button key={pid} className="row with-icon" onClick={() => setPerson(pid)}>
              <span className="cat-icon sm" aria-hidden="true">{pmap.get(pid)?.name.slice(0, 1) ?? '?'}</span>
              <span className="row-main row-title">{pmap.get(pid)?.name ?? '?'}</span>
              <div className="row-end">
                {[...byCur].filter(([, v]) => v).map(([cur, v]) => (
                  <div key={cur}><Amount minor={v} currency={cur} tone={v > 0 ? 'pos' : 'neg'} className="num" /> <span className="row-sub">{v > 0 ? '欠我' : '我欠'}</span></div>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
      <Sheet open={adding} onClose={() => setAdding(false)} title="記錄應收／應付">
        {adding && <DebtForm onClose={() => setAdding(false)} />}
      </Sheet>
      <Sheet open={!!person} onClose={() => setPerson(null)} title={person ? pmap.get(person)?.name : ''}>
        {person && <PersonDebts personId={person} debts={(debts ?? []).filter((d) => d.personId === person)} />}
      </Sheet>
    </>
  );
}

function PersonDebts({ personId, debts }: { personId: string; debts: Debt[] }) {
  const accounts = useAccounts();
  const [settleAcc, setSettleAcc] = useState(accounts.list[0]?.id ?? '');
  const [touched, setTouched] = useState(false);
  const [showSettled, setShowSettled] = useState(false);
  const list = debts.filter((d) => (showSettled ? true : !d.settled)).sort((a, b) => (a.date < b.date ? 1 : -1));
  const open = debts.filter((d) => !d.settled);
  // 預設結清帳戶：借出／借入當初使用的帳戶，否則第一個帳戶（帳戶清單載入較晚時補上）
  const loanTxId = open.find((d) => d.loanTxId)?.loanTxId;
  useEffect(() => {
    if (touched || !accounts.list.length) return;
    let alive = true;
    (async () => {
      const tx = loanTxId ? await db.transactions.get(loanTxId) : undefined;
      const id = tx && accounts.map.has(tx.accountId) ? tx.accountId : settleAcc || accounts.list[0].id;
      if (alive) setSettleAcc(id);
    })();
    return () => { alive = false; };
  }, [accounts.list.length, loanTxId, touched]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="list">
        <AccountField label="結清入帳到" value={settleAcc} onChange={(v) => { setTouched(true); setSettleAcc(v); }} accounts={accounts.list} allowEmpty emptyLabel="只標記結清，不記帳" />
      </div>
      {open.length > 1 && (
        <button className="btn tinted" style={{ marginBottom: 12 }} onClick={async () => {
          for (const d of open) await settleDebt(d.id, settleAcc || undefined);
          useUI.getState().showSnack({ text: `已結清 ${open.length} 筆` });
        }}>全部結清</button>
      )}
      <div className="list">
        {list.map((d) => (
          <div key={d.id} className="row" style={{ opacity: d.settled ? 0.5 : 1 }}>
            <div className="row-main">
              <div className="row-title">{d.note || (d.loanTxId ? (d.direction === 'they_owe_me' ? '借出' : '借入') : d.direction === 'they_owe_me' ? '代墊' : '借款')}</div>
              <div className="row-sub">{d.date} · {d.direction === 'they_owe_me' ? '應收' : '應付'}{d.loanTxId ? '（已動帳戶）' : ''}{d.settled ? ' · 已結清' : ''}</div>
            </div>
            <Amount minor={d.direction === 'they_owe_me' ? d.amountMinor : -d.amountMinor} currency={d.currency} tone="auto" className="num" />
            {d.settled ? (
              <button className="btn small secondary" onClick={() => void unsettleDebt(d.id)}>取消</button>
            ) : (
              <button className="btn small" onClick={() => void settleDebt(d.id, settleAcc || undefined).then(() => useUI.getState().showSnack({ text: '已結清' }))}>結清</button>
            )}
          </div>
        ))}
      </div>
      <button className="btn secondary small" onClick={() => setShowSettled((s) => !s)}>{showSettled ? '隱藏已結清' : '顯示已結清'}</button>
      <button className="btn danger small" style={{ marginLeft: 8 }} onClick={async () => {
        if (!window.confirm('刪除此人的所有已結清紀錄？')) return;
        await db.debts.where('personId').equals(personId).filter((d) => !!d.settled).delete();
      }}>清除已結清</button>
    </>
  );
}

function DebtForm({ onClose }: { onClose: () => void }) {
  const base = useSettings((s) => s.baseCurrency);
  const cats = useCategories();
  const people = useLiveQuery(() => db.people.toArray(), []) ?? [];
  const [name, setName] = useState('');
  const [direction, setDirection] = useState<Debt['direction']>('they_owe_me');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayKey());
  const [note, setNote] = useState('');
  const [categoryId, setCategoryId] = useState('exp-food');
  const save = async () => {
    const v = evaluate(amount || '0');
    if (!name.trim() || !v || v.lte(0)) { useUI.getState().showSnack({ text: '請輸入對象與金額' }); return; }
    const p = await findOrCreatePerson(name);
    await addDebts([{ personId: p.id, direction, amountMinor: toMinor(v, base), currency: base, date, note, categoryId: direction === 'i_owe_them' ? categoryId : undefined }]);
    onClose();
  };
  return (
    <>
      <Segmented value={direction} onChange={setDirection} options={[{ value: 'they_owe_me', label: '應收（對方欠我）' }, { value: 'i_owe_them', label: '應付（我欠對方）' }]} ariaLabel="方向" />
      <div className="list" style={{ marginTop: 12 }}>
        <TextField label="對象" value={name} onChange={setName} placeholder="名字" />
        <AmountField label="金額" value={amount} onChange={setAmount} currency={base} />
        <DateField label="日期" value={date} onChange={setDate} />
        <TextField label="備註" value={note} onChange={setNote} />
        {direction === 'i_owe_them' && <CategoryField label="還款時記為" value={categoryId} onChange={setCategoryId} categories={cats.all} kind="expense" />}
      </div>
      {people.length > 0 && (
        <div className="sub-row">{people.map((p) => <button key={p.id} className="pill" aria-pressed={name === p.name} onClick={() => setName(p.name)}>{p.name}</button>)}</div>
      )}
      <button className="btn" onClick={() => void save()}>儲存</button>
    </>
  );
}

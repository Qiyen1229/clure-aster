/**
 * 分帳（AA 制）：我先付全額，選擇一起分攤的人；平均拆分（含自己）或自訂每人金額。
 * 儲存後：帳戶扣全額、收支統計只算我的份額、其他人各產生一筆「對方欠我」。
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { splitEqually } from '@/domain/debt';
import { formatMoney, fromMinor, toMinor } from '@/domain/money';
import { Sheet } from '@/ui/Sheet';
import { Segmented } from '@/ui/controls';

export interface SplitState {
  mode: 'equal' | 'custom';
  people: { name: string; amount: string }[];
}

export function computeSplit(totalMinor: number, s: SplitState, currency: string): { myShare: number; shares: { name: string; minor: number }[]; error?: string } {
  if (!s.people.length) return { myShare: totalMinor, shares: [] };
  if (s.mode === 'equal') {
    const parts = splitEqually(totalMinor, s.people.length + 1);
    return { myShare: parts[0], shares: s.people.map((p, i) => ({ name: p.name, minor: parts[i + 1] })) };
  }
  const shares = s.people.map((p) => ({ name: p.name, minor: p.amount ? toMinor(p.amount, currency) : 0 }));
  const others = shares.reduce((a, x) => a + x.minor, 0);
  if (others > totalMinor) return { myShare: 0, shares, error: '分攤金額超過總額' };
  return { myShare: totalMinor - others, shares };
}

export function SplitSheet({ open, onClose, value, onChange, totalMinor, currency }: {
  open: boolean; onClose: () => void; value: SplitState; onChange: (s: SplitState) => void; totalMinor: number; currency: string;
}) {
  const people = useLiveQuery(() => db.people.toArray(), []) ?? [];
  const [name, setName] = useState('');
  const add = (n: string) => {
    const v = n.trim();
    if (!v || value.people.some((p) => p.name === v)) return;
    onChange({ ...value, people: [...value.people, { name: v, amount: '' }] });
    setName('');
  };
  const r = computeSplit(totalMinor, value, currency);
  return (
    <Sheet open={open} onClose={onClose} title="分帳" right={<button className="accent" style={{ minHeight: 44, fontWeight: 600 }} onClick={onClose}>完成</button>}>
      <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>由我先付 {formatMoney(totalMinor, currency)}，其他人之後還我。收支統計只會計入我的份額。</p>
      <Segmented value={value.mode} onChange={(m) => onChange({ ...value, mode: m })} options={[{ value: 'equal', label: '平均分（含我）' }, { value: 'custom', label: '自訂金額' }]} ariaLabel="分帳方式" />
      <form onSubmit={(e) => { e.preventDefault(); add(name); }} style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <input className="input" placeholder="加入一起分的人" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
        <button className="btn small" type="submit" disabled={!name.trim()}>加入</button>
      </form>
      {people.length > 0 && (
        <div className="sub-row">
          {people.filter((p) => !value.people.some((x) => x.name === p.name)).map((p) => <button key={p.id} className="pill" onClick={() => add(p.name)}>＋ {p.name}</button>)}
        </div>
      )}
      <div className="list">
        <div className="row"><span className="row-main">我</span><b className="num">{formatMoney(r.myShare, currency)}</b></div>
        {value.people.map((p, i) => (
          <div key={p.name} className="row">
            <span className="row-main">{p.name}</span>
            {value.mode === 'custom' ? (
              <input className="input num" style={{ width: 110, textAlign: 'right' }} inputMode="decimal" value={p.amount} placeholder="0"
                onChange={(e) => onChange({ ...value, people: value.people.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/[^0-9.]/g, '') } : x)) })} />
            ) : <span className="num">{formatMoney(r.shares[i]?.minor ?? 0, currency)}</span>}
            <button className="icon-btn plain" aria-label={`移除 ${p.name}`} onClick={() => onChange({ ...value, people: value.people.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
      </div>
      {r.error && <p style={{ color: 'var(--danger)' }}>{r.error}</p>}
      {value.people.length > 0 && value.mode === 'equal' && (
        <p className="muted" style={{ fontSize: '0.8rem' }}>{value.people.length + 1} 人平分，每人約 {fromMinor(r.myShare, currency).toString()}</p>
      )}
    </Sheet>
  );
}

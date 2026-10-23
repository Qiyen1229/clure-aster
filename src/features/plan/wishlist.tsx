/**
 * 心願清單（冷靜期）：想買的非必需品先放進來，設定 7／14／30 天冷靜期。
 * 到期前提醒「你還想買這個嗎？」；決定買 → 開啟記帳面板預填；放棄 → 計入「冷靜期幫你省下」。
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Wish } from '@/db/types';
import { addWish, decideWish, extendWish } from '@/db/repo/plan';
import { fromMinor, toMinor } from '@/domain/money';
import { evaluate } from '@/domain/calc-expr';
import { fromDateKey, todayKey } from '@/domain/period';
import { useCategories } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { AmountField, CategoryField, SelectField, TextField } from '@/ui/form';
import { Sheet } from '@/ui/Sheet';
import { SectionHead } from './PlanPage';

export function daysUntil(dateKey: string, today = todayKey()): number {
  return Math.round((fromDateKey(dateKey).getTime() - fromDateKey(today).getTime()) / 86400000);
}

export default function WishlistSection() {
  const base = useSettings((s) => s.baseCurrency);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<'waiting' | 'done'>('waiting');
  const wishes = useLiveQuery(() => db.wishes.toArray(), []);
  const openAdd = useUI((s) => s.openAdd);

  const saved = (wishes ?? []).filter((w) => w.status === 'abandoned' && w.currency === base).reduce((a, w) => a + w.priceMinor, 0);
  const waiting = (wishes ?? []).filter((w) => w.status === 'waiting').sort((a, b) => (a.decideAt < b.decideAt ? -1 : 1));
  const done = (wishes ?? []).filter((w) => w.status !== 'waiting').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));

  const buy = (w: Wish) => {
    void decideWish(w.id, 'bought');
    openAdd({ mode: 'expense', amount: fromMinor(w.priceMinor, w.currency).toString(), note: w.name, categoryId: w.categoryId });
  };
  const abandon = (w: Wish) => {
    void decideWish(w.id, 'abandoned').then(() => snackUndo(`冷靜期幫你省下 ${fromMinor(w.priceMinor, w.currency).toString()} 元 🎉`, async () => { await db.wishes.update(w.id, { status: 'waiting', decidedAt: undefined }); }));
  };

  return (
    <>
      <SectionHead title="心願清單" onAdd={() => setAdding(true)} addLabel="想買" />
      <div className="card glass">
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
          <div><div className="muted" style={{ fontSize: '0.75rem' }}>冷靜中</div><div className="num" style={{ fontWeight: 700 }}>{waiting.length}</div></div>
          <div><div className="muted" style={{ fontSize: '0.75rem' }}>已放棄</div><div className="num" style={{ fontWeight: 700 }}>{done.filter((w) => w.status === 'abandoned').length}</div></div>
          <div><div className="muted" style={{ fontSize: '0.75rem' }}>冷靜期幫你省下</div><div className="num" style={{ fontWeight: 700, color: 'var(--success)' }}><Amount minor={saved} currency={base} tone="none" /></div></div>
        </div>
      </div>
      <Segmented value={tab} onChange={setTab} options={[{ value: 'waiting', label: `冷靜中（${waiting.length}）` }, { value: 'done', label: '已決定' }]} ariaLabel="狀態" />
      {!wishes ? <SkeletonRows /> : tab === 'waiting' ? (
        waiting.length === 0 ? (
          <EmptyState emoji="🧊" title="沒有冷靜中的心願" text="想衝動購物時，先放進來冷靜 7 天。到期還想要再買，常常就不想要了。"
            action={<button className="btn small" onClick={() => setAdding(true)}>加入心願</button>} />
        ) : waiting.map((w) => {
          const left = daysUntil(w.decideAt);
          const total = Math.max(1, w.coolDays);
          const pct = Math.min(100, ((total - Math.max(0, left)) / total) * 100);
          return (
            <div key={w.id} className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="row-main">
                  <div style={{ fontWeight: 600 }}>{w.name}</div>
                  <div className="row-sub">{left > 0 ? `冷靜期剩 ${left} 天（${w.decideAt.slice(5).replace('-', '/')}）` : '冷靜期結束，你還想買嗎？'}{w.note ? ` · ${w.note}` : ''}</div>
                </div>
                <Amount minor={w.priceMinor} currency={w.currency} tone="none" className="num" />
              </div>
              <div className="bar" style={{ margin: '10px 0' }}><i style={{ width: `${pct}%`, ['--c' as string]: left > 0 ? 'var(--accent)' : 'var(--warning)' }} /></div>
              <div className="btn-row">
                <button className="btn small secondary" style={{ flex: 1 }} onClick={() => void extendWish(w.id, 7)}>再冷靜 7 天</button>
                <button className="btn small tinted" style={{ flex: 1 }} onClick={() => abandon(w)}>放棄購買</button>
                <button className="btn small" style={{ flex: 1 }} onClick={() => {
                  if (left > 0 && !window.confirm(`冷靜期還有 ${left} 天，確定現在就買？`)) return;
                  buy(w);
                }}>買了</button>
              </div>
              {w.url && /^https?:\/\//.test(w.url) && <a className="accent" style={{ fontSize: '0.8rem' }} href={w.url} target="_blank" rel="noopener noreferrer">商品連結</a>}
            </div>
          );
        })
      ) : (
        done.length === 0 ? <EmptyState emoji="📭" title="還沒有決定過的心願" /> : (
          <div className="list" style={{ marginTop: 12 }}>
            {done.map((w) => (
              <div key={w.id} className="row">
                <div className="row-main">
                  <div className="row-title">{w.name}</div>
                  <div className="row-sub">{w.status === 'abandoned' ? '✅ 放棄購買，省下了' : '🛍️ 買了'} · {w.decidedAt ? new Date(w.decidedAt).toLocaleDateString('zh-TW') : ''}</div>
                </div>
                <Amount minor={w.priceMinor} currency={w.currency} tone="none" className="num" />
                <button className="icon-btn plain" aria-label={`刪除 ${w.name}`} onClick={() => void db.wishes.delete(w.id)}>✕</button>
              </div>
            ))}
          </div>
        )
      )}
      <Sheet open={adding} onClose={() => setAdding(false)} title="加入心願清單">
        {adding && <WishForm onClose={() => setAdding(false)} />}
      </Sheet>
    </>
  );
}

function WishForm({ onClose }: { onClose: () => void }) {
  const base = useSettings((s) => s.baseCurrency);
  const cats = useCategories();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [days, setDays] = useState(7);
  const [categoryId, setCategoryId] = useState('exp-shopping');
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const save = async () => {
    const v = evaluate(price || '0');
    if (!name.trim() || !v || v.lte(0)) { useUI.getState().showSnack({ text: '請輸入名稱與價格' }); return; }
    await addWish({ name: name.trim(), priceMinor: toMinor(v, base), currency: base, coolDays: days, categoryId, note, url: url.trim() || undefined });
    useUI.getState().showSnack({ text: `已加入，${days} 天後再決定 🧊` });
    onClose();
  };
  return (
    <>
      <div className="list">
        <TextField label="想買什麼" value={name} onChange={setName} placeholder="例如：降噪耳機" />
        <AmountField label="價格" value={price} onChange={setPrice} currency={base} />
        <SelectField label="冷靜期" value={days} onChange={setDays} options={[3, 7, 14, 30].map((d) => ({ value: d, label: `${d} 天` }))} />
        <CategoryField label="分類" value={categoryId} onChange={setCategoryId} categories={cats.all} kind="expense" />
        <TextField label="為什麼想要" value={note} onChange={setNote} maxLength={100} />
        <TextField label="商品連結" value={url} onChange={setUrl} type="url" maxLength={300} />
      </div>
      <button className="btn" onClick={() => void save()}>開始冷靜期</button>
    </>
  );
}

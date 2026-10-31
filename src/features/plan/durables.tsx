/**
 * 耐用品（計畫頁 → 耐用品）：3C、家電、機車、名牌包這類大額消費，追蹤「每日持有成本」。
 *   - 還在用：已用幾天、每天攤多少、預計壽命的進度、再用多久每天降到多少（有填使用次數時還有每次成本）
 *   - 賣掉／淘汰：扣掉二手殘值算出「真實成本」，可同時記一筆收入關聯回物品
 * 購入時也可以在記帳面板直接標記「耐用品」，會自動建立這裡的一筆。
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Durable } from '@/db/types';
import { addDurable, addUse, deleteDurable, reopenDurable, sellDurable, updateDurable } from '@/db/repo/durables';
import { durableStats, lifeLabel, totalDailyBurn } from '@/domain/durable';
import { evaluate } from '@/domain/calc-expr';
import { currencyInfo, formatMoney, fromMinor, toMinor } from '@/domain/money';
import { todayKey } from '@/domain/period';
import { useAccounts, useCategories } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { snackUndo, useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { AccountField, AmountField, CategoryField, DateField, SelectField, SwitchField, TextField } from '@/ui/form';
import { Sheet } from '@/ui/Sheet';
import { SectionHead } from './PlanPage';
import { LifeSpanSheet } from './LifeSpanSheet';

/** 金額：一般顯示到整數，小額（< 10 元）留一位小數，才看得出每天幾毛錢的差別 */
const fm = (minor: number, cur: string) => formatMoney(minor, cur, { decimals: currencyInfo(cur).exp === 0 || Math.abs(minor) >= 1000 ? 0 : 1 });

const LIFE_PRESETS = [1, 2, 3, 5, 7, 10];
const lifeOptions = (custom: number) => [
  ...[0, ...LIFE_PRESETS].map((y) => ({ value: y, label: y ? `${y} 年` : '不設定' })),
  { value: -1, label: custom > 0 ? `${lifeLabel(custom)}（自訂）` : '自訂期限…' },
  ...(custom > 0 ? [{ value: -2, label: '修改自訂期限…' }] : []),
];
const ICONS = ['📱', '💻', '🎧', '📷', '⌚', '🛵', '🚲', '👜', '👟', '🧊', '📺', '🛋️', '🎮', '🎸', '📦'];

export default function DurableSection() {
  const base = useSettings((s) => s.baseCurrency);
  const [tab, setTab] = useState<'active' | 'done'>('active');
  const [form, setForm] = useState<{ edit?: Durable } | null>(null);
  const [selling, setSelling] = useState<Durable | null>(null);
  const list = useLiveQuery(() => db.durables.toArray(), []);
  const today = todayKey();

  const active = (list ?? []).filter((d) => d.status === 'active').sort((a, b) => (a.purchaseDate < b.purchaseDate ? -1 : 1));
  const done = (list ?? []).filter((d) => d.status !== 'active').sort((a, b) => ((b.endDate ?? '') < (a.endDate ?? '') ? -1 : 1));
  const burn = totalDailyBurn(active, today, base);

  return (
    <>
      <SectionHead title="耐用品" onAdd={() => setForm({})} addLabel="新增" />
      <div className="card glass">
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
          <div><div className="muted" style={{ fontSize: '0.75rem' }}>還在用</div><div className="num" style={{ fontWeight: 700 }}>{active.length} 件</div></div>
          <div><div className="muted" style={{ fontSize: '0.75rem' }}>每天合計</div><div className="num" style={{ fontWeight: 700 }}><Amount minor={burn} currency={base} tone="none" /></div></div>
          <div><div className="muted" style={{ fontSize: '0.75rem' }}>已出手</div><div className="num" style={{ fontWeight: 700 }}>{done.length} 件</div></div>
        </div>
        <p className="muted" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>手機、家電、機車這類大額消費，用越久每天越划算。這裡看它每天攤多少，賣掉時算出真實成本。</p>
      </div>
      <Segmented value={tab} onChange={setTab} options={[{ value: 'active', label: `還在用（${active.length}）` }, { value: 'done', label: `已出手（${done.length}）` }]} ariaLabel="狀態" />

      {!list ? <SkeletonRows /> : tab === 'active' ? (
        active.length === 0 ? (
          <EmptyState emoji="🧰" title="還沒有耐用品" text="買了大件的東西，記帳時選「耐用品」，或在這裡新增。之後每天都看得到它攤了多少錢。"
            action={<button className="btn small" onClick={() => setForm({})}>新增耐用品</button>} />
        ) : active.map((d) => <ActiveCard key={d.id} d={d} today={today} onEdit={() => setForm({ edit: d })} onSell={() => setSelling(d)} />)
      ) : done.length === 0 ? <EmptyState emoji="📭" title="還沒有賣掉或淘汰的物品" /> : done.map((d) => (
        <DoneCard key={d.id} d={d} onReopen={() => void reopenDurable(d.id)} onDelete={() => {
          if (!window.confirm(`刪除「${d.name}」的紀錄？已記的帳目不受影響。`)) return;
          const copy = { ...d };
          void deleteDurable(d.id).then(() => snackUndo('已刪除', async () => { await db.durables.put(copy); }));
        }} />
      ))}

      <Sheet open={!!form} onClose={() => setForm(null)} title={form?.edit ? '編輯耐用品' : '新增耐用品'}>
        {form && <DurableForm edit={form.edit} onClose={() => setForm(null)} />}
      </Sheet>
      <Sheet open={!!selling} onClose={() => setSelling(null)} title={selling ? `處理「${selling.name}」` : ''}>
        {selling && <SellForm d={selling} onClose={() => setSelling(null)} />}
      </Sheet>
    </>
  );
}

function ActiveCard({ d, today, onEdit, onSell }: { d: Durable; today: string; onEdit: () => void; onSell: () => void }) {
  const s = durableStats(d, today);
  const pct = s.usedRatio !== undefined ? Math.min(100, s.usedRatio * 100) : null;
  const over = s.usedRatio !== undefined && s.usedRatio >= 1;
  return (
    <div className="card dur-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="dur-icon" aria-hidden="true">{d.icon}</span>
        <div className="row-main">
          <div style={{ fontWeight: 650 }}>{d.name}</div>
          <div className="row-sub">{d.purchaseDate.replace(/-/g, '/')}・{fm(d.costMinor, d.currency)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="num dur-perday">{fm(s.perDayMinor, d.currency)}<span className="muted dur-unit">／天</span></div>
          <div className="row-sub">已用 {s.days.toLocaleString()} 天</div>
        </div>
      </div>
      {pct !== null && (
        <>
          <div className="bar" style={{ margin: '12px 0 6px' }}><i style={{ width: `${pct}%`, ['--c' as string]: over ? 'var(--success)' : 'var(--accent)' }} /></div>
          <div className="row-sub" style={{ whiteSpace: 'normal' }}>
            {over
              ? `✅ 已超過預計的 ${lifeLabel(d.lifeYears ?? 0)}，每天只要 ${fm(s.perDayMinor, d.currency)}，已經很划算`
              : `已攤提 ${Math.round(pct)}%（預計用 ${lifeLabel(d.lifeYears ?? 0)}，目標每天 ${fm(s.targetPerDayMinor!, d.currency)}）・再用 ${s.remainingDays} 天用滿`}
          </div>
        </>
      )}
      {!over && (
        <div className="row-sub" style={{ marginTop: 4, whiteSpace: 'normal' }}>
          再用 1 年，每天降到 {fm(s.perDayAfter!(365), d.currency)}
        </div>
      )}
      {d.trackUses && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <span className="row-sub" style={{ flex: 1 }}>已使用 {d.uses ?? 0} 次{s.perUseMinor !== undefined ? `・每次 ${fm(s.perUseMinor, d.currency)}` : ''}</span>
          <button className="btn small tinted" onClick={() => void addUse(d.id, -1)} aria-label="少算一次" disabled={!d.uses}>−</button>
          <button className="btn small" onClick={() => void addUse(d.id)}>用了一次</button>
        </div>
      )}
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn small secondary" style={{ flex: 1 }} onClick={onEdit}>編輯</button>
        <button className="btn small tinted" style={{ flex: 1 }} onClick={onSell}>賣掉／淘汰</button>
      </div>
    </div>
  );
}

function DoneCard({ d, onReopen, onDelete }: { d: Durable; onReopen: () => void; onDelete: () => void }) {
  const s = durableStats(d, todayKey());
  const sold = d.status === 'sold';
  return (
    <div className="card dur-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="dur-icon" aria-hidden="true">{d.icon}</span>
        <div className="row-main">
          <div style={{ fontWeight: 650 }}>{d.name}</div>
          <div className="row-sub">{sold ? '賣掉' : '淘汰'}於 {d.endDate?.replace(/-/g, '/')}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="num dur-perday">{fm(s.perDayMinor, d.currency)}<span className="muted dur-unit">／天</span></div>
          <div className="row-sub">真實成本</div>
        </div>
      </div>
      <p className="row-sub" style={{ whiteSpace: 'normal', margin: '10px 0 0' }}>
        {d.name}陪了你 {s.days.toLocaleString()} 天。買 {fm(d.costMinor, d.currency)}
        {sold ? `、賣 ${fm(d.saleMinor ?? 0, d.currency)}，扣掉二手殘值後真實成本每天只要 ${fm(s.perDayMinor, d.currency)}（沒賣的話是 ${fm(s.grossPerDayMinor, d.currency)}）` : `，每天 ${fm(s.perDayMinor, d.currency)}`}。
        {s.perUseMinor !== undefined ? ` 用了 ${d.uses} 次，每次 ${fm(s.perUseMinor, d.currency)}。` : ''}
      </p>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="btn small secondary" style={{ flex: 1 }} onClick={onReopen}>改回還在用</button>
        <button className="btn small tinted" style={{ flex: 1, color: 'var(--danger)' }} onClick={onDelete}>刪除紀錄</button>
      </div>
    </div>
  );
}

function DurableForm({ edit, onClose }: { edit?: Durable; onClose: () => void }) {
  const base = useSettings((s) => s.baseCurrency);
  const [name, setName] = useState(edit?.name ?? '');
  const [icon, setIcon] = useState(edit?.icon ?? '📦');
  const [price, setPrice] = useState(edit ? fromMinor(edit.costMinor, edit.currency).toString() : '');
  const [date, setDate] = useState(edit?.purchaseDate ?? todayKey());
  const [years, setYears] = useState(edit?.lifeYears ?? 3);
  /** 自訂期限（年；0＝沒有自訂）。目前值不是預設選項時視為自訂 */
  const [custom, setCustom] = useState(edit?.lifeYears && !LIFE_PRESETS.includes(edit.lifeYears) ? edit.lifeYears : 0);
  const [lifeOpen, setLifeOpen] = useState(false);
  const [trackUses, setTrackUses] = useState(!!edit?.trackUses);
  const [uses, setUses] = useState(String(edit?.uses ?? 0));
  const [note, setNote] = useState(edit?.note ?? '');
  const cur = edit?.currency ?? base;
  const save = async () => {
    const v = evaluate(price || '0');
    if (!name.trim() || !v || v.lte(0)) { useUI.getState().showSnack({ text: '請輸入名稱與購入價' }); return; }
    const patch = {
      name: name.trim(), icon, purchaseDate: date, costMinor: toMinor(v, cur), currency: cur, lifeYears: years || undefined,
      trackUses, uses: trackUses ? Math.max(0, Math.round(Number(uses) || 0)) : undefined, note: note.trim() || undefined,
    };
    if (edit) await updateDurable(edit.id, patch); else await addDurable(patch);
    useUI.getState().showSnack({ text: edit ? '已更新' : `已加入，從 ${date.replace(/-/g, '/')} 開始算每天的成本` });
    onClose();
  };
  return (
    <>
      <div className="list">
        <TextField label="名稱" value={name} onChange={setName} placeholder="例如：iPhone 16 Pro" />
        <div className="field" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="label">圖示</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flex: 1, justifyContent: 'flex-end' }}>
            {ICONS.map((i) => <button key={i} type="button" className="pill" aria-pressed={icon === i} onClick={() => setIcon(i)}>{i}</button>)}
          </div>
        </div>
        <AmountField label="購入價" value={price} onChange={setPrice} currency={cur} />
        <DateField label="購入日" value={date} onChange={setDate} max={todayKey()} />
        <SelectField label="預計使用" value={custom > 0 && years === custom ? -1 : years} options={lifeOptions(custom)}
          onChange={(v) => { if (v < 0) setLifeOpen(true); else setYears(v); }} />
        <SwitchField label="追蹤使用次數" sub="單車、相機、樂器這類用「次」比用「天」有意義的物品，可以算每次使用成本" checked={trackUses} onChange={setTrackUses} />
        {trackUses && <TextField label="目前已使用" value={uses} onChange={(v) => setUses(v.replace(/\D/g, ''))} inputMode="numeric" maxLength={6} />}
        <TextField label="備註" value={note} onChange={setNote} maxLength={100} />
      </div>
      <button className="btn" onClick={() => void save()}>{edit ? '儲存' : '開始追蹤'}</button>
      <LifeSpanSheet open={lifeOpen} initialYears={custom || years} onClose={() => setLifeOpen(false)} onConfirm={(y) => { setCustom(y); setYears(y); }} />
    </>
  );
}

function SellForm({ d, onClose }: { d: Durable; onClose: () => void }) {
  const accounts = useAccounts();
  const cats = useCategories();
  const lastAcc = useSettings((s) => s.lastAccountId);
  const pay = accounts.list.filter((a) => a.type !== 'loan' && a.type !== 'brokerage');
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(todayKey());
  const [record, setRecord] = useState(true);
  const [accPick, setAccId] = useState('');
  const [catPick, setCatId] = useState('');
  // 帳戶與分類資料是非同步載入的：還沒選過就用預設（上次用的帳戶、「其他」收入分類）
  const accId = accPick || (pay.find((a) => a.id === lastAcc)?.id ?? pay[0]?.id ?? '');
  const catId = catPick || (cats.all.find((c) => c.id === 'inc-other_inc')?.id ?? '');
  const v = evaluate(price || '0');
  const sale = v && v.gt(0) ? toMinor(v, d.currency) : 0;
  const preview = durableStats({ ...d, status: sale > 0 ? 'sold' : 'retired', endDate: date, saleMinor: sale }, todayKey());
  const submit = async () => {
    try {
      await sellDurable({ id: d.id, endDate: date, saleMinor: sale, income: record && sale > 0 && accId && catId ? { accountId: accId, categoryId: catId } : undefined });
      useUI.getState().showSnack({ text: sale > 0 ? `陪了你 ${preview.days} 天，真實成本每天 ${fm(preview.perDayMinor, d.currency)}` : `陪了你 ${preview.days} 天，每天 ${fm(preview.perDayMinor, d.currency)}`, duration: 7000 });
      onClose();
    } catch (e) { useUI.getState().showSnack({ text: (e as Error).message }); }
  };
  return (
    <>
      <div className="list">
        <AmountField label="二手賣了多少（淘汰或送人留空）" value={price} onChange={setPrice} currency={d.currency} />
        <DateField label="處置日" value={date} onChange={setDate} min={d.purchaseDate} max={todayKey()} />
        {sale > 0 && (
          <>
            <SwitchField label="同時記一筆收入" sub="記為「二手賣出」收入並關聯這件物品" checked={record} onChange={setRecord} />
            {record && <AccountField label="入帳帳戶" value={accId} onChange={setAccId} accounts={pay} />}
            {record && <CategoryField label="收入分類" value={catId} onChange={setCatId} categories={cats.all} kind="income" />}
          </>
        )}
      </div>
      <div className="card glass" aria-live="polite">
        <div className="muted" style={{ fontSize: '0.8rem' }}>{d.name}陪了你 {preview.days.toLocaleString()} 天</div>
        <div className="num dur-perday" style={{ fontSize: '1.4rem' }}>{fm(preview.perDayMinor, d.currency)}<span className="muted dur-unit">／天</span></div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>
          {sale > 0 ? `買 ${fm(d.costMinor, d.currency)}、賣 ${fm(sale, d.currency)}，淨成本 ${fm(preview.netCostMinor, d.currency)}` : `淨成本 ${fm(d.costMinor, d.currency)}`}
        </div>
      </div>
      <button className="btn" onClick={() => void submit()}>{sale > 0 ? '賣掉了' : '淘汰'}</button>
    </>
  );
}

/**
 * 週期帳目與訂閱管理：每日／週／月／年／自訂間隔、到期自動入帳或待確認、續約提醒、年度訂閱總花費。
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { RecurrenceRule, RecurringRule } from '@/db/types';
import { confirmPending, saveRecurring, skipPending } from '@/db/repo/plan';
import { describeRule, timesPerYear } from '@/domain/recurrence';
import { convertMinor, fromMinor, toMinor } from '@/domain/money';
import { evaluate } from '@/domain/calc-expr';
import { todayKey } from '@/domain/period';
import { resolveRate } from '@/services/fx';
import { useAccounts, useCategories } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Amount, EmptyState, Segmented, SkeletonRows } from '@/ui/controls';
import { AccountField, AmountField, CategoryField, DateField, SelectField, TextField } from '@/ui/form';
import { Sheet } from '@/ui/Sheet';
import { SectionHead } from './PlanPage';

const PRESETS: { name: string; amount: string; currency: string; cat: string }[] = [
  { name: 'Netflix', amount: '390', currency: 'TWD', cat: 'exp-subscription-video' },
  { name: 'Spotify', amount: '149', currency: 'TWD', cat: 'exp-subscription-musicsub' },
  { name: 'YouTube Premium', amount: '199', currency: 'TWD', cat: 'exp-subscription-video' },
  { name: 'Disney+', amount: '270', currency: 'TWD', cat: 'exp-subscription-video' },
  { name: 'iCloud+', amount: '90', currency: 'TWD', cat: 'exp-subscription-cloud' },
  { name: 'Apple Music', amount: '165', currency: 'TWD', cat: 'exp-subscription-musicsub' },
  { name: 'ChatGPT Plus', amount: '20', currency: 'USD', cat: 'exp-subscription-cloud' },
  { name: 'Claude Pro', amount: '20', currency: 'USD', cat: 'exp-subscription-cloud' },
];

export default function RecurringSection() {
  const [edit, setEdit] = useState<RecurringRule | 'new' | 'newsub' | null>(null);
  const [kind, setKind] = useState<'all' | 'subscription'>('all');
  const rules = useLiveQuery(() => db.recurring_rules.toArray(), []);
  const rates = useLiveQuery(async () => new Map((await db.exchange_rates.toArray()).map((r) => [`${r.base}>${r.quote}`, r])), []);
  const base = useSettings((s) => s.baseCurrency);
  const cats = useCategories();
  const accounts = useAccounts(true);
  const [confirming, setConfirming] = useState<{ rule: RecurringRule; date: string } | null>(null);

  const pending = (rules ?? []).flatMap((r) => r.pendingDates.map((d) => ({ rule: r, date: d }))).sort((a, b) => (a.date < b.date ? -1 : 1));
  const shown = (rules ?? []).filter((r) => (kind === 'all' || r.kind === 'subscription')).sort((a, b) => (b.active - a.active) || (a.nextDue < b.nextDue ? -1 : 1));
  const toBase = (r: RecurringRule) => {
    const amt = r.template.amountMinor ?? 0;
    const cur = r.template.currency ?? base;
    if (cur === base) return amt;
    const rate = rates ? resolveRate(rates, cur, base) : null;
    return rate ? convertMinor(amt, cur, base, rate) : 0;
  };
  const subs = (rules ?? []).filter((r) => r.kind === 'subscription' && r.active && r.template.type !== 'income');
  const yearly = subs.reduce((a, r) => a + Math.round(toBase(r) * timesPerYear(r.rule)), 0);

  return (
    <>
      <SectionHead title="週期帳目" onAdd={() => setEdit(kind === 'subscription' ? 'newsub' : 'new')} />
      <Segmented value={kind} onChange={setKind} options={[{ value: 'all', label: '全部' }, { value: 'subscription', label: '訂閱服務' }]} ariaLabel="篩選" />
      {subs.length > 0 && (
        <div className="card glass" style={{ marginTop: 12 }}>
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
            <div><div className="muted" style={{ fontSize: '0.75rem' }}>訂閱數</div><div className="num" style={{ fontWeight: 700 }}>{subs.length}</div></div>
            <div><div className="muted" style={{ fontSize: '0.75rem' }}>每月約</div><div className="num" style={{ fontWeight: 700 }}><Amount minor={Math.round(yearly / 12)} currency={base} tone="none" /></div></div>
            <div><div className="muted" style={{ fontSize: '0.75rem' }}>年度總花費</div><div className="num" style={{ fontWeight: 700 }}><Amount minor={yearly} currency={base} tone="neg" /></div></div>
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <>
          <div className="section-title">待確認（{pending.length}）</div>
          <div className="list">
            {pending.map(({ rule, date }) => (
              <div key={rule.id + date} className="row">
                <div className="row-main">
                  <div className="row-title">{rule.name}</div>
                  <div className="row-sub">{date} · <Amount minor={rule.template.amountMinor ?? 0} currency={rule.template.currency ?? base} tone="none" /></div>
                </div>
                <button className="btn small secondary" onClick={() => void skipPending(rule.id, date)}>略過</button>
                <button className="btn small" onClick={() => setConfirming({ rule, date })}>入帳</button>
              </div>
            ))}
          </div>
        </>
      )}
      {!rules ? <SkeletonRows /> : shown.length === 0 ? (
        <EmptyState emoji="🔁" title={kind === 'subscription' ? '還沒有訂閱' : '還沒有週期帳目'} text="房租、薪水、Netflix、保險費…設定一次，到期自動入帳或提醒你確認。"
          action={<button className="btn small" onClick={() => setEdit(kind === 'subscription' ? 'newsub' : 'new')}>新增</button>} />
      ) : (
        <div className="list" style={{ marginTop: 12 }}>
          {shown.map((r) => {
            const c = r.template.categoryId ? cats.map.get(r.template.categoryId) : undefined;
            const soon = r.active && r.nextDue <= todayKey().slice(0, 8) + '31' && r.nextDue >= todayKey();
            return (
              <button key={r.id} className="row with-icon" onClick={() => setEdit(r)} style={{ opacity: r.active ? 1 : 0.5 }}>
                <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true">{r.kind === 'subscription' ? '📺' : c?.icon ?? '🔁'}</span>
                <div className="row-main">
                  <div className="row-title">{r.name}{r.kind === 'subscription' && <span className="chip" style={{ marginLeft: 6 }}>訂閱</span>}</div>
                  <div className="row-sub">{describeRule(r.rule)} · {r.mode === 'auto' ? '自動入帳' : '需確認'} · {accounts.map.get(r.template.accountId ?? '')?.name ?? '帳戶已刪除'}</div>
                </div>
                <div className="row-end">
                  <Amount minor={r.template.type === 'income' ? r.template.amountMinor ?? 0 : -(r.template.amountMinor ?? 0)} currency={r.template.currency ?? base} tone="auto" className="num" />
                  <div className="row-sub" style={{ color: soon ? 'var(--warning)' : undefined }}>{r.active ? `下次 ${r.nextDue.slice(5).replace('-', '/')}` : '已結束'}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
      <Sheet open={edit !== null} onClose={() => setEdit(null)} title={edit && typeof edit === 'object' ? '編輯週期' : '新增週期'} full>
        {edit !== null && <RecurringForm key={typeof edit === 'object' ? edit.id : edit} rule={typeof edit === 'object' ? edit : undefined}
          subscription={edit === 'newsub'} onClose={() => setEdit(null)} />}
      </Sheet>
      <Sheet open={!!confirming} onClose={() => setConfirming(null)} title="確認入帳">
        {confirming && <ConfirmForm rule={confirming.rule} date={confirming.date} onClose={() => setConfirming(null)} />}
      </Sheet>
    </>
  );
}

function ConfirmForm({ rule, date, onClose }: { rule: RecurringRule; date: string; onClose: () => void }) {
  const cur = rule.template.currency ?? 'TWD';
  const [amount, setAmount] = useState(fromMinor(rule.template.amountMinor ?? 0, cur).toString());
  return (
    <>
      <p className="muted">{rule.name} · {date}。金額若有變動（例如帳單金額不同）可先修改。</p>
      <div className="list"><AmountField label="金額" value={amount} onChange={setAmount} currency={cur} /></div>
      <button className="btn" onClick={async () => {
        const v = evaluate(amount);
        if (!v || v.lte(0)) return;
        await confirmPending(rule.id, date, toMinor(v, cur));
        useUI.getState().showSnack({ text: '已入帳' });
        onClose();
      }}>確認入帳</button>
    </>
  );
}

function RecurringForm({ rule, subscription, onClose }: { rule?: RecurringRule; subscription?: boolean; onClose: () => void }) {
  const accounts = useAccounts();
  const cats = useCategories();
  const settings = useSettings();
  const t = rule?.template;
  const [kind, setKind] = useState<RecurringRule['kind']>(rule?.kind ?? (subscription ? 'subscription' : 'normal'));
  const [type, setType] = useState<'expense' | 'income'>((t?.type as 'expense' | 'income') ?? 'expense');
  const [name, setName] = useState(rule?.name ?? '');
  const [accountId, setAccountId] = useState(t?.accountId ?? (settings.lastAccountId || accounts.list[0]?.id || ''));
  const acc = accounts.map.get(accountId);
  const [currency, setCurrency] = useState(t?.currency ?? acc?.currency ?? settings.baseCurrency);
  const [amount, setAmount] = useState(t?.amountMinor ? fromMinor(t.amountMinor, t.currency ?? 'TWD').toString() : '');
  const [categoryId, setCategoryId] = useState(t?.categoryId ?? (subscription ? 'exp-subscription' : ''));
  const [startDate, setStartDate] = useState(rule?.startDate ?? todayKey());
  const [freq, setFreq] = useState<RecurrenceRule['freq']>(rule?.rule.freq ?? 'month');
  const [interval, setInterval] = useState(String(rule?.rule.interval ?? 1));
  const [weekdays, setWeekdays] = useState<number[]>(rule?.rule.byWeekday ?? []);
  const [monthEnd, setMonthEnd] = useState<'clamp' | 'skip'>(rule?.rule.monthEndPolicy ?? 'clamp');
  const [endMode, setEndMode] = useState<'never' | 'until' | 'count'>(rule?.rule.until ? 'until' : rule?.rule.count ? 'count' : 'never');
  const [until, setUntil] = useState(rule?.rule.until ?? '');
  const [count, setCount] = useState(String(rule?.rule.count ?? 12));
  const [mode, setMode] = useState<RecurringRule['mode']>(rule?.mode ?? (subscription ? 'auto' : 'confirm'));
  const [remind, setRemind] = useState(String(rule?.remindDaysBefore ?? 2));
  const [note, setNote] = useState(t?.note ?? '');

  const save = async () => {
    const v = evaluate(amount || '0');
    if (!name.trim()) return useUI.getState().showSnack({ text: '請輸入名稱' });
    if (!v || v.lte(0)) return useUI.getState().showSnack({ text: '請輸入金額' });
    if (!accountId) return useUI.getState().showSnack({ text: '請選擇帳戶' });
    if (!categoryId) return useUI.getState().showSnack({ text: '請選擇分類' });
    const r: RecurrenceRule = {
      freq, interval: Math.max(1, Number(interval) || 1),
      byWeekday: freq === 'week' && weekdays.length ? weekdays : undefined,
      monthEndPolicy: monthEnd,
      until: endMode === 'until' && until ? until : undefined,
      count: endMode === 'count' ? Math.max(1, Number(count) || 1) : undefined,
    };
    const amountMinor = toMinor(v, currency);
    await saveRecurring({
      kind, name: name.trim(), rule: r, startDate, mode, remindDaysBefore: Number(remind) || 0, active: rule ? rule.active : 1,
      template: { type, accountId, categoryId, amountMinor, currency, note },
      subscription: kind === 'subscription' ? { service: name.trim(), priceHistory: rule?.subscription?.priceHistory ?? [{ date: startDate, amountMinor }] } : undefined,
    }, rule?.id);
    useUI.getState().showSnack({ text: '已儲存，會在開啟 App 時自動處理到期項目' });
    onClose();
  };

  const W = ['日', '一', '二', '三', '四', '五', '六'];
  return (
    <>
      <Segmented value={kind} onChange={setKind} options={[{ value: 'normal', label: '一般週期' }, { value: 'subscription', label: '訂閱服務' }]} ariaLabel="種類" />
      {kind === 'subscription' && !rule && (
        <div className="sub-row" aria-label="常見訂閱">
          {PRESETS.map((p) => (
            <button key={p.name} className="pill" onClick={() => { setName(p.name); setAmount(p.amount); setCurrency(p.currency); setCategoryId(p.cat); }}>{p.name}</button>
          ))}
        </div>
      )}
      <div style={{ margin: '10px 0' }}>
        <Segmented value={type} onChange={(v) => { setType(v); setCategoryId(''); }} options={[{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }]} ariaLabel="收支" />
      </div>
      <div className="list">
        <TextField label="名稱" value={name} onChange={setName} placeholder={kind === 'subscription' ? 'Netflix' : '房租'} />
        <AmountField label="金額" value={amount} onChange={setAmount} currency={currency} />
        <SelectField label="幣別" value={currency} onChange={setCurrency}
          options={[...new Set([acc?.currency ?? settings.baseCurrency, settings.baseCurrency, 'USD', 'JPY'])].map((c) => ({ value: c, label: c }))} />
        <AccountField value={accountId} onChange={(id) => { setAccountId(id); const a = accounts.map.get(id); if (a && !t) setCurrency(a.currency); }} accounts={accounts.list} />
        <CategoryField value={categoryId} onChange={setCategoryId} categories={cats.all} kind={type} allowEmpty emptyLabel="請選擇" />
        <TextField label="備註" value={note} onChange={setNote} />
      </div>
      <div className="section-title">重複</div>
      <div className="list">
        <DateField label="第一次" value={startDate} onChange={setStartDate} />
        <SelectField label="頻率" value={freq} onChange={setFreq} options={[{ value: 'day', label: '每天' }, { value: 'week', label: '每週' }, { value: 'month', label: '每月' }, { value: 'year', label: '每年' }]} />
        <TextField label="每幾個週期" value={interval} onChange={(v) => setInterval(v.replace(/\D/g, ''))} inputMode="numeric" />
        {freq === 'week' && (
          <div className="field" style={{ flexWrap: 'wrap' }}>
            <span className="label">星期</span>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {W.map((w, i) => (
                <button key={i} className="pill" style={{ padding: '0 10px' }} aria-pressed={weekdays.includes(i)}
                  onClick={() => setWeekdays((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]))}>{w}</button>
              ))}
            </div>
          </div>
        )}
        {(freq === 'month' || freq === 'year') && Number(startDate.slice(8)) > 28 && (
          <SelectField label="沒有該日時" value={monthEnd} onChange={setMonthEnd} options={[{ value: 'clamp', label: '改在月底' }, { value: 'skip', label: '略過該月' }]} />
        )}
        <SelectField label="結束" value={endMode} onChange={setEndMode} options={[{ value: 'never', label: '永不' }, { value: 'until', label: '於某日' }, { value: 'count', label: '共幾次' }]} />
        {endMode === 'until' && <DateField label="結束日" value={until} onChange={setUntil} min={startDate} />}
        {endMode === 'count' && <TextField label="次數" value={count} onChange={(v) => setCount(v.replace(/\D/g, ''))} inputMode="numeric" />}
      </div>
      <div className="section-title">到期時</div>
      <div className="list">
        <SelectField label="處理方式" value={mode} onChange={setMode} options={[{ value: 'auto', label: '自動入帳' }, { value: 'confirm', label: '提醒我確認' }]} />
        <TextField label="提前提醒（天）" value={remind} onChange={(v) => setRemind(v.replace(/\D/g, ''))} inputMode="numeric" />
      </div>
      {rule?.subscription?.priceHistory && rule.subscription.priceHistory.length > 1 && (
        <p className="muted" style={{ fontSize: '0.8rem' }}>價格紀錄：{rule.subscription.priceHistory.map((p) => `${p.date} ${fromMinor(p.amountMinor, currency)}`).join(' → ')}</p>
      )}
      <button className="btn" onClick={() => void save()}>儲存</button>
      {rule && (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn secondary" onClick={async () => { await db.recurring_rules.update(rule.id, { active: rule.active ? 0 : 1 }); onClose(); }}>{rule.active ? '停用' : '啟用'}</button>
          <button className="btn danger" onClick={async () => {
            if (!window.confirm(`刪除「${rule.name}」？已入帳的帳目會保留。`)) return;
            await db.recurring_rules.delete(rule.id);
            onClose();
          }}>刪除</button>
        </div>
      )}
    </>
  );
}

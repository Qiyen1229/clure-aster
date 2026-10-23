/**
 * 表單共用元件（iOS 設定頁風格的列）：文字、金額、日期、下拉、帳戶、分類、開關。
 */
import { useId, type ReactNode } from 'react';
import type { Account, Category, CategoryKind } from '@/db/types';
import { buildTree } from '@/db/repo/categories';
import { CURRENCIES, currencyInfo } from '@/domain/money';
import { Switch } from './controls';

export function FieldRow({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field" title={hint}>
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

export function TextField({ label, value, onChange, placeholder, maxLength = 60, type = 'text', inputMode }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number; type?: string; inputMode?: 'decimal' | 'numeric' | 'text';
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} inputMode={inputMode} value={value} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** 金額輸入（字串，只允許數字與小數點；可選允許負號） */
export function AmountField({ label, value, onChange, currency, allowNegative, placeholder = '0' }: {
  label: string; value: string; onChange: (v: string) => void; currency?: string; allowNegative?: boolean; placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} inputMode="decimal" className="num" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.replace(allowNegative ? /[^0-9.-]/g : /[^0-9.]/g, ''))} />
      {currency && <span className="muted">{currencyInfo(currency).symbol}</span>}
    </div>
  );
}

export function DateField({ label, value, onChange, min, max, type = 'date' }: { label: string; value: string; onChange: (v: string) => void; min?: string; max?: string; type?: 'date' | 'time' | 'month' }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} min={min} max={max} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function SelectField<T extends string | number>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[];
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={String(value)} onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}>
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function SwitchField({ label, checked, onChange, sub }: { label: string; checked: boolean; onChange: (v: boolean) => void; sub?: string }) {
  return (
    <div className="field">
      <span className="label" style={{ flex: 1, width: 'auto' }}>
        {label}
        {sub && <span className="row-sub" style={{ display: 'block', whiteSpace: 'normal' }}>{sub}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export function AccountField({ label = '帳戶', value, onChange, accounts, allowEmpty, emptyLabel = '（不指定）', filter }: {
  label?: string; value: string; onChange: (v: string) => void; accounts: Account[]; allowEmpty?: boolean; emptyLabel?: string; filter?: (a: Account) => boolean;
}) {
  const id = useId();
  const list = accounts.filter((a) => !a.archived && (!filter || filter(a)));
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {allowEmpty && <option value="">{emptyLabel}</option>}
        {list.map((a) => <option key={a.id} value={a.id}>{a.icon} {a.name}（{a.currency}）</option>)}
      </select>
    </div>
  );
}

export function CategoryField({ label = '分類', value, onChange, categories, kind, allowEmpty, emptyLabel = '全部分類' }: {
  label?: string; value: string; onChange: (v: string) => void; categories: Category[]; kind: CategoryKind; allowEmpty?: boolean; emptyLabel?: string;
}) {
  const id = useId();
  const tree = buildTree(categories, kind);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {allowEmpty && <option value="">{emptyLabel}</option>}
        {tree.map(({ main, subs }) => (
          <optgroup key={main.id} label={`${main.icon} ${main.name}`}>
            <option value={main.id}>{main.icon} {main.name}（全部）</option>
            {subs.map((s) => <option key={s.id} value={s.id}>　{s.icon} {s.name}</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

export function CurrencyField({ label = '幣別', value, onChange, disabled }: { label?: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <SelectField label={label} value={value} onChange={onChange}
      options={Object.values(CURRENCIES).map((c) => ({ value: c.code, label: `${c.code} ${c.name}` })).filter(() => !disabled || true)} />
  );
}

/** 環形進度（存錢目標、預算） */
export function Ring({ pct, size = 64, stroke = 7, color = 'var(--accent)', children }: { pct: number; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }} role="img" aria-label={`進度 ${Math.round(p)}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} className="ring-anim" style={{ ['--c' as string]: c }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: size > 70 ? '0.95rem' : '0.75rem', fontWeight: 700 }} className="num">
        {children ?? `${Math.round(p)}%`}
      </div>
    </div>
  );
}

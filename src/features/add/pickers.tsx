/**
 * 記帳面板用的選擇器（皆為巢狀 Bottom Sheet）：帳戶、幣別、標籤、專案。
 */
import { useState } from 'react';
import { db, uid } from '@/db/schema';
import type { Account, Project, Tag } from '@/db/types';
import { CURRENCIES } from '@/domain/money';
import { Sheet } from '@/ui/Sheet';
import { Amount } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { CATEGORY_COLORS } from '@/db/seed/categories';
import { accountTypeInfo } from '@/db/repo/accounts';
import { lifeLabel } from '@/domain/durable';

export function AccountPicker({ open, onClose, accounts, value, onPick, title = '選擇帳戶', exclude }: {
  open: boolean; onClose: () => void; accounts: Account[]; value?: string; onPick: (id: string) => void; title?: string; exclude?: string;
}) {
  const list = accounts.filter((a) => a.id !== exclude);
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {list.length === 0 ? (
        <p className="muted" style={{ textAlign: 'center' }}>尚無其他帳戶，請先到「帳戶」頁新增。</p>
      ) : (
        <div className="list">
          {list.map((a) => (
            <button key={a.id} className="row with-icon" onClick={() => { onPick(a.id); onClose(); }} aria-pressed={a.id === value}>
              <span className="cat-icon sm" style={{ ['--c' as string]: a.color }} aria-hidden="true">{a.icon}</span>
              <div className="row-main">
                <div className="row-title">{a.name}</div>
                <div className="row-sub">{accountTypeInfo(a.type).label} · {a.currency}</div>
              </div>
              <Amount minor={a.balanceMinor} currency={a.currency} tone="none" className="row-value" />
              {a.id === value && <Icon name="check" className="accent" />}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

export function CurrencyPicker({ open, onClose, value, onPick }: { open: boolean; onClose: () => void; value: string; onPick: (c: string) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="選擇幣別">
      <div className="list">
        {Object.values(CURRENCIES).map((c) => (
          <button key={c.code} className="row" onClick={() => { onPick(c.code); onClose(); }}>
            <span className="num" style={{ width: 44, fontWeight: 600 }}>{c.code}</span>
            <span className="row-main">{c.name}</span>
            <span className="muted">{c.symbol}</span>
            {c.code === value && <Icon name="check" className="accent" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function TagPicker({ open, onClose, tags, value, onChange }: {
  open: boolean; onClose: () => void; tags: Tag[]; value: string[]; onChange: (ids: string[]) => void;
}) {
  const [name, setName] = useState('');
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    const exist = tags.find((t) => t.name === n);
    if (exist) { if (!value.includes(exist.id)) onChange([...value, exist.id]); setName(''); return; }
    const now = Date.now();
    const tag: Tag = { id: uid(), name: n, color: CATEGORY_COLORS[tags.length % CATEGORY_COLORS.length], sort: tags.length, createdAt: now, updatedAt: now };
    await db.tags.add(tag);
    onChange([...value, tag.id]);
    setName('');
  };
  return (
    <Sheet open={open} onClose={onClose} title="標籤" right={<button className="accent" style={{ minHeight: 44, fontWeight: 600 }} onClick={onClose}>完成</button>}>
      <form onSubmit={(e) => { e.preventDefault(); void create(); }} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input className="input" placeholder="新增標籤，例如：出差、約會" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
        <button className="btn small" type="submit" disabled={!name.trim()}>新增</button>
      </form>
      {tags.length === 0 ? (
        <p className="muted" style={{ textAlign: 'center' }}>還沒有標籤。一筆帳可以有多個標籤，方便日後篩選。</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {tags.map((t) => (
            <button key={t.id} className="pill" aria-pressed={value.includes(t.id)} onClick={() => toggle(t.id)}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: t.color }} />{t.name}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

export function ProjectPicker({ open, onClose, projects, value, onPick }: {
  open: boolean; onClose: () => void; projects: Project[]; value?: string; onPick: (id: string) => void;
}) {
  const active = projects.filter((p) => p.status === 'active');
  return (
    <Sheet open={open} onClose={onClose} title="專案">
      <div className="list">
        <button className="row" onClick={() => { onPick(''); onClose(); }}>
          <span className="row-main">不屬於任何專案</span>
          {!value && <Icon name="check" className="accent" />}
        </button>
        {active.map((p) => (
          <button key={p.id} className="row" onClick={() => { onPick(p.id); onClose(); }}>
            <span aria-hidden="true">{p.icon}</span>
            <span className="row-main">{p.name}</span>
            {p.id === value && <Icon name="check" className="accent" />}
          </button>
        ))}
      </div>
      {active.length === 0 && <p className="muted" style={{ textAlign: 'center' }}>專案管理將於階段 2 推出。</p>}
    </Sheet>
  );
}

export function DurablePicker({
  open,
  onClose,
  value,
  custom,
  onPick,
  onCustom,
}: {
  open: boolean;
  onClose: () => void;
  value: number;
  custom: number;
  onPick: (years: number) => void;
  onCustom: () => void;
}) {
  const presets = [1, 2, 3, 5, 7, 10];
  return (
    <Sheet open={open} onClose={onClose} title="標記為耐用品">
      <p className="muted" style={{ fontSize: '0.84rem', margin: '0 4px 12px' }}>
        設定預計使用期限，自動計算每日持有成本（手機、筆電、機車、家電等）。
      </p>
      <div className="list">
        <button
          type="button"
          className="row"
          onClick={() => { onPick(0); onClose(); }}
          aria-pressed={value === 0}
        >
          <span className="row-main">不追蹤（一般支出）</span>
          {value === 0 && <Icon name="check" className="accent" />}
        </button>

        {presets.map((y) => (
          <button
            key={y}
            type="button"
            className="row"
            onClick={() => { onPick(y); onClose(); }}
            aria-pressed={value === y && value !== custom}
          >
            <span className="row-main">預計使用 {y} 年</span>
            {value === y && value !== custom && <Icon name="check" className="accent" />}
          </button>
        ))}

        {custom > 0 && (
          <button
            type="button"
            className="row"
            onClick={() => { onPick(custom); onClose(); }}
            aria-pressed={value === custom}
          >
            <span className="row-main">自訂：{lifeLabel(custom)}</span>
            {value === custom && <Icon name="check" className="accent" />}
          </button>
        )}

        <button
          type="button"
          className="row accent"
          onClick={() => { onClose(); onCustom(); }}
        >
          <Icon name="edit" size={16} />
          <span className="row-main">{custom > 0 ? '修改自訂期限…' : '自訂使用期限…'}</span>
        </button>
      </div>
    </Sheet>
  );
}


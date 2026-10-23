/**
 * 進階篩選：類型、帳戶、分類（主分類含子分類）、專案、標籤（任一／全部）、金額區間、關鍵字；可儲存成常用篩選。
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { TxFilter, TxType } from '@/db/types';
import { saveFilter } from '@/db/repo/plan';
import { buildTree } from '@/db/repo/categories';
import { fromMinor, toMinor } from '@/domain/money';
import { useAccounts, useCategories, useProjects, useTags } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { Sheet } from '@/ui/Sheet';
import { Segmented } from '@/ui/controls';
import { Icon } from '@/ui/Icon';

export function filterCount(f: TxFilter): number {
  return (f.types?.length ? 1 : 0) + (f.accountIds?.length ? 1 : 0) + (f.categoryIds?.length ? 1 : 0) + (f.projectIds?.length ? 1 : 0)
    + (f.tagIds?.length ? 1 : 0) + (f.minMinor !== undefined || f.maxMinor !== undefined ? 1 : 0) + (f.keyword ? 1 : 0);
}

function Chips<T extends string>({ items, value, onChange }: { items: { id: T; label: string }[]; value: T[] | undefined; onChange: (v: T[]) => void }) {
  const v = value ?? [];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
      {items.map((it) => (
        <button key={it.id} className="pill" aria-pressed={v.includes(it.id)} onClick={() => onChange(v.includes(it.id) ? v.filter((x) => x !== it.id) : [...v, it.id])}>{it.label}</button>
      ))}
    </div>
  );
}

export function FilterSheet({ open, onClose, value, onChange }: { open: boolean; onClose: () => void; value: TxFilter; onChange: (f: TxFilter) => void }) {
  const accounts = useAccounts(true);
  const cats = useCategories();
  const projects = useProjects();
  const tags = useTags();
  const base = useSettings((s) => s.baseCurrency);
  const saved = useLiveQuery(() => db.saved_filters.orderBy('sort').toArray(), []) ?? [];
  const [catKind, setCatKind] = useState<'expense' | 'income'>('expense');
  const f = value;
  const set = (patch: Partial<TxFilter>) => onChange({ ...f, ...patch });
  const TYPES: { id: TxType; label: string }[] = [{ id: 'expense', label: '支出' }, { id: 'income', label: '收入' }, { id: 'adjust', label: '餘額調整' }];
  const tree = buildTree(cats.all, catKind);

  return (
    <Sheet open={open} onClose={onClose} title="篩選" full
      left={<button className="accent" style={{ minHeight: 44 }} onClick={() => onChange({})}>清除</button>}
      right={<button className="accent" style={{ minHeight: 44, fontWeight: 600 }} onClick={onClose}>套用</button>}>
      {saved.length > 0 && (
        <>
          <div className="section-title">常用篩選</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {saved.map((s) => (
              <span key={s.id} className="pill">
                <button onClick={() => { onChange(s.filter); onClose(); }}>{s.name}</button>
                <button aria-label={`刪除 ${s.name}`} onClick={() => void db.saved_filters.delete(s.id)}><Icon name="close" size={14} /></button>
              </span>
            ))}
          </div>
        </>
      )}
      <div className="section-title">關鍵字（備註）</div>
      <input className="input" value={f.keyword ?? ''} onChange={(e) => set({ keyword: e.target.value || undefined })} placeholder="例如：Uber、全聯" />
      <div className="section-title">類型</div>
      <Chips items={TYPES} value={f.types} onChange={(v) => set({ types: v.length ? v : undefined })} />
      <div className="section-title">帳戶</div>
      <Chips items={accounts.list.map((a) => ({ id: a.id, label: `${a.icon} ${a.name}` }))} value={f.accountIds} onChange={(v) => set({ accountIds: v.length ? v : undefined })} />
      <div className="section-title">分類</div>
      <Segmented value={catKind} onChange={setCatKind} options={[{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }]} ariaLabel="分類類型" />
      <div style={{ marginTop: 8 }}>
        <Chips items={tree.map(({ main }) => ({ id: main.id, label: `${main.icon} ${main.name}` }))} value={f.categoryIds} onChange={(v) => set({ categoryIds: v.length ? v : undefined })} />
      </div>
      {projects.list.length > 0 && (
        <>
          <div className="section-title">專案</div>
          <Chips items={projects.list.map((p) => ({ id: p.id, label: `${p.icon} ${p.name}` }))} value={f.projectIds} onChange={(v) => set({ projectIds: v.length ? v : undefined })} />
        </>
      )}
      {tags.list.length > 0 && (
        <>
          <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            標籤
            <span style={{ width: 150 }}><Segmented value={f.tagMode ?? 'any'} onChange={(m) => set({ tagMode: m })} options={[{ value: 'any', label: '任一' }, { value: 'all', label: '全部' }]} ariaLabel="標籤條件" /></span>
          </div>
          <Chips items={tags.list.map((t) => ({ id: t.id, label: t.name }))} value={f.tagIds} onChange={(v) => set({ tagIds: v.length ? v : undefined })} />
        </>
      )}
      <div className="section-title">金額區間（原幣）</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="input num" inputMode="decimal" placeholder="最小" value={f.minMinor !== undefined ? fromMinor(f.minMinor, base).toString() : ''}
          onChange={(e) => set({ minMinor: e.target.value ? toMinor(e.target.value.replace(/[^0-9.]/g, '') || '0', base) : undefined })} />
        <span className="muted">–</span>
        <input className="input num" inputMode="decimal" placeholder="最大" value={f.maxMinor !== undefined ? fromMinor(f.maxMinor, base).toString() : ''}
          onChange={(e) => set({ maxMinor: e.target.value ? toMinor(e.target.value.replace(/[^0-9.]/g, '') || '0', base) : undefined })} />
      </div>
      <button className="btn tinted" style={{ marginTop: 16 }} disabled={!filterCount(f)} onClick={async () => {
        const name = window.prompt('篩選名稱', '我的篩選');
        if (!name) return;
        await saveFilter(name, f);
        useUI.getState().showSnack({ text: `已儲存「${name}」` });
      }}>儲存為常用篩選</button>
    </Sheet>
  );
}

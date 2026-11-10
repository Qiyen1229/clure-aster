/**
 * 常用項目（釘選）：管理在記帳面板最前面的「肯德基 晚餐 $160」這類一點就能套用的項目。
 * 新增釘選：記帳面板輸入金額後按右上角的 📌、長按建議膠囊、或在帳目列表長按一筆選「釘選為常用」。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAccounts, useCategories } from '@/app/hooks';
import { listPinned, MAX_PINNED, pinNote, unpin, updatePinnedAmount } from '@/db/repo/pinned';
import type { Template } from '@/db/types';
import { formatMoney, fromMinor, toMinor } from '@/domain/money';
import { useUI, ask } from '@/stores/ui';
import { EmptyState } from '@/ui/controls';
import { CatIcon, Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

export default function PinnedPage() {
  const navigate = useNavigate();
  const list = useLiveQuery(() => listPinned(), []);
  const { map: catMap } = useCategories();
  const { map: accMap } = useAccounts(true);
  const [edit, setEdit] = useState<Template | null>(null);
  const [amount, setAmount] = useState('');

  const save = async () => {
    if (!edit) return;
    const cur = edit.payload.currency ?? 'TWD';
    const minor = toMinor(amount || '0', cur);
    if (!(minor > 0)) { useUI.getState().showSnack({ text: '金額要大於 0' }); return; }
    await updatePinnedAmount(edit.id, minor);
    setEdit(null);
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>常用項目</h1>
        <div style={{ width: 44 }} />
      </header>
      <p className="muted" style={{ margin: '0 4px 10px' }}>
        偶爾才記的消費（例如「肯德基 晚餐 $160」）可以釘選：記帳時排在建議最前面，一點就帶入金額、分類、帳戶與標籤。最多 {MAX_PINNED} 個，用得越多排越前面。
      </p>
      {!list ? null : list.length === 0 ? (
        <EmptyState emoji="📌" title="還沒有釘選" text="在記帳面板輸入金額後，按右上角的 📌；或在帳目列表長按一筆，選「釘選為常用」。" />
      ) : (
        <div className="list">
          {list.map((t) => {
            const c = t.payload.categoryId ? catMap.get(t.payload.categoryId) : undefined;
            const acc = t.payload.accountId ? accMap.get(t.payload.accountId) : undefined;
            const cur = t.payload.currency ?? 'TWD';
            return (
              <div key={t.id} className="row pinned-row">
                <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true"><CatIcon icon={c?.icon ?? 'pin'} size={16} /></span>
                <button className="row-main" style={{ textAlign: 'left' }} onClick={() => { setEdit(t); setAmount(fromMinor(t.payload.amountMinor ?? 0, cur).toString()); }} aria-label={`編輯 ${pinNote(t)} 的金額`}>
                  <span className="row-title">{pinNote(t)}</span>
                  <span className="row-sub" style={{ whiteSpace: 'normal' }}>{t.payload.type === 'income' ? '收入' : '支出'} · {c?.name ?? '分類已刪除'} · {acc?.name ?? '帳戶已刪除'}{t.useCount ? ` · 用過 ${t.useCount} 次` : ''}</span>
                </button>
                <span className="num">{formatMoney(t.payload.amountMinor ?? 0, cur)}</span>
                <button className="icon-btn plain" aria-label={`取消釘選 ${pinNote(t)}`} onClick={async () => {
                  if (!await ask(`取消釘選「${pinNote(t)}」？已經記好的帳目不受影響。`, { confirmText: '取消釘選' })) return;
                  await unpin(t.id);
                }}><Icon name="trash" size={18} /></button>
              </div>
            );
          })}
        </div>
      )}
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit ? `修改「${pinNote(edit)}」的金額` : ''}>
        {edit && (
          <div className="auth-form" style={{ gap: 10 }}>
            <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onFocus={(e) => e.target.select()} aria-label="金額" autoFocus />
            <button className="btn" onClick={() => void save()}>儲存</button>
          </div>
        )}
      </Sheet>
    </main>
  );
}

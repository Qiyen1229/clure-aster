/**
 * 帳目列（月曆頁與帳目列表共用）：分類圖示、名稱、帳戶／備註、金額、標籤。
 * 左滑刪除（附復原）、右滑編輯、長按快捷選單。
 */
import { memo } from 'react';
import type { Account, Category, Tag } from '@/db/types';
import type { LedgerItem } from '@/db/repo/ledger';
import { deleteTransactions, deleteTransfers, restoreTransactions, restoreTransfers, addTransaction } from '@/db/repo/ledger';
import { SwipeRow } from '@/ui/SwipeRow';
import { Amount } from '@/ui/controls';
import { snackUndo, useUI } from '@/stores/ui';
import { categoryLabel } from '@/app/hooks';
import { fromMinor } from '@/domain/money';
import { Icon } from '@/ui/Icon';
import { todayKey } from '@/domain/period';

interface Props {
  item: LedgerItem;
  cats: Map<string, Category>;
  accounts: Map<string, Account>;
  tags: Map<string, Tag>;
  showDate?: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export function deleteItem(item: LedgerItem) {
  if (item.kind === 'tx') {
    void deleteTransactions([item.id]).then(() => snackUndo('已刪除 1 筆', () => restoreTransactions([item.id])));
  } else {
    void deleteTransfers([item.id]).then(() => snackUndo('已刪除轉帳', () => restoreTransfers([item.id])));
  }
}

function LedgerRowImpl({ item, cats, accounts, tags, showDate, selectMode, selected, onToggleSelect }: Props) {
  const { editTx, editTransfer, showActions, openAdd } = useUI.getState();
  const edit = () => (item.kind === 'tx' ? editTx(item.id) : editTransfer(item.id));

  let icon: string, color: string, title: string, sub: string, amount: number, currency: string, tone: 'pos' | 'neg' | 'none';
  let tagIds: string[] = [];
  if (item.kind === 'tx') {
    const t = item.tx;
    const c = cats.get(t.categoryId);
    const acc = accounts.get(t.accountId);
    icon = c?.icon ?? '❔';
    color = c?.color ?? '#8E8E93';
    title = t.note || (c ? c.name : '未分類');
    sub = [t.note ? categoryLabel(cats, t.categoryId) : null, acc?.name].filter(Boolean).join(' / ');
    amount = t.type === 'income' ? t.amountMinor : t.type === 'adjust' ? t.amountMinor : -t.amountMinor;
    currency = t.currency;
    tone = t.type === 'income' ? 'pos' : t.type === 'adjust' ? 'none' : 'neg';
    tagIds = t.tagIds;
  } else {
    const tr = item.tr;
    const from = accounts.get(tr.fromAccountId);
    const to = accounts.get(tr.toAccountId);
    icon = '🔁';
    color = '#64D2FF';
    title = tr.note || '轉帳';
    sub = `${from?.name ?? '?'} → ${to?.name ?? '?'}${tr.feeMinor ? '（含手續費）' : ''}`;
    amount = tr.fromAmountMinor;
    currency = from?.currency ?? 'TWD';
    tone = 'none';
    tagIds = tr.tagIds;
  }

  const longPress = () => showActions(title, [
    { label: '編輯', icon: '✏️', onSelect: edit },
    ...(item.kind === 'tx' && item.tx.type !== 'adjust' ? [{
      label: '複製一筆到今天', icon: '📄', onSelect: () => {
        const t = item.tx;
        void addTransaction({
          type: t.type, accountId: t.accountId, categoryId: t.categoryId, amountMinor: t.amountMinor,
          currency: t.currency, fxRateDec: t.fxRateDec, date: todayKey(), ts: Date.now(), note: t.note, tagIds: t.tagIds, projectId: t.projectId,
        }).then(() => useUI.getState().showSnack({ text: '已複製到今天' }));
      },
    }, {
      label: '以此為範本記一筆', icon: '➕', onSelect: () => openAdd({
        mode: item.tx.type, categoryId: item.tx.categoryId, accountId: item.tx.accountId,
        amount: fromMinor(item.tx.amountMinor, item.tx.currency).toString(), note: item.tx.note, tagIds: item.tx.tagIds,
      }),
    }] : []),
    { label: '刪除', icon: '🗑️', danger: true, onSelect: () => deleteItem(item) },
  ]);

  const body = (
    <div className={`row tx-row${selectMode ? ' selectable' : ''}`} aria-selected={selectMode ? selected : undefined}>
      {selectMode && <span className="check" aria-hidden="true">{selected && <Icon name="check" size={14} stroke={3} />}</span>}
      <span className="cat-icon" style={{ ['--c' as string]: color }} aria-hidden="true">{icon}</span>
      <div className="row-main">
        <div className="row-title">{title}</div>
        <div className="row-sub">{showDate ? `${item.date.slice(5).replace('-', '/')} · ` : ''}{sub}</div>
      </div>
      <div className="row-end">
        <Amount className="tx-amount" minor={amount} currency={currency} tone={tone} opts={{ sign: tone === 'none' ? 'negative' : 'never' }} />
        {tagIds.length > 0 && (
          <div className="chips">
            {tagIds.slice(0, 3).map((id) => {
              const tg = tags.get(id);
              return tg ? <span key={id} className="chip" style={{ ['--c' as string]: tg.color }}>{tg.name}</span> : null;
            })}
          </div>
        )}
      </div>
    </div>
  );

  if (selectMode) {
    return (
      <div className="swipe" onClick={() => onToggleSelect?.(item.id)} role="checkbox" aria-checked={selected} tabIndex={0}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onToggleSelect?.(item.id); } }}>
        <div className="swipe-content">{body}</div>
      </div>
    );
  }
  return (
    <SwipeRow onTap={edit} onEdit={edit} onDelete={() => deleteItem(item)} onLongPress={longPress}>
      {body}
    </SwipeRow>
  );
}

export const LedgerRow = memo(LedgerRowImpl);

/**
 * 左滑刪除的「延遲寫入＋復原」佇列：滑掉後列先從畫面消失，3 秒內可按「復原」救回，
 * 時間到才真的寫入資料庫。一次只保留一筆待刪——再刪下一筆時，上一筆立刻確定刪除。
 * 離開頁面（卸載）時把待刪項目直接寫入，避免刪到一半的懸置狀態。
 */
import { useEffect, useState } from 'react';
import { useUI } from '@/stores/ui';

export const UNDO_MS = 3000;

interface Pending {
  id: string;
  commit: () => void | Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  snackId: number | null;
}

export interface DeleteQueue {
  request: (id: string, label: string, commit: () => void | Promise<void>) => void;
  undo: () => void;
  flushAll: () => void;
}

export function createDeleteQueue(onChange: (pendingIds: Set<string>) => void): DeleteQueue {
  let pending: Pending | null = null;
  const emit = () => onChange(new Set(pending ? [pending.id] : []));
  const dismissOwnSnack = (p: Pending) => {
    const ui = useUI.getState();
    if (p.snackId !== null && ui.snack?.id === p.snackId) ui.dismissSnack();
  };

  const settle = (p: Pending) => {
    clearTimeout(p.timer);
    void p.commit();
    dismissOwnSnack(p);
  };

  const flushAll = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    settle(p);
    emit();
  };

  const undo = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    dismissOwnSnack(p);
    emit();
  };

  const request = (id: string, label: string, commit: () => void | Promise<void>) => {
    flushAll();
    const timer = setTimeout(() => {
      if (!pending || pending.id !== id) return;
      const p = pending;
      pending = null;
      settle(p);
      emit();
    }, UNDO_MS);
    pending = { id, commit, timer, snackId: null };
    emit();
    useUI.getState().showSnack({
      text: `已刪除「${label}」`,
      actionLabel: '復原',
      duration: UNDO_MS,
      onAction: undo,
    });
    if (pending?.id === id) pending.snackId = useUI.getState().snack?.id ?? null;
  };

  return { request, undo, flushAll };
}

/** 列表頁用法：pendingIds 裡的列先隱藏；requestDelete 排入 3 秒復原佇列 */
export function useSwipeDelete() {
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [queue] = useState(() => createDeleteQueue(setPendingIds));
  useEffect(() => () => queue.flushAll(), [queue]);
  return { pendingIds, requestDelete: queue.request };
}
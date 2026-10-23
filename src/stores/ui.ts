/**
 * 全域 UI 狀態：記帳面板、Snackbar（含復原）、動作選單。
 */
import { create } from 'zustand';
import type { TxType } from '@/db/types';
import { todayKey } from '@/domain/period';

/** receivable = 應收（借出）、payable = 應付（借入） */
export type AddMode = TxType | 'transfer' | 'receivable' | 'payable';

export interface AddPrefill {
  mode?: AddMode;
  amount?: string;
  categoryId?: string;
  accountId?: string;
  toAccountId?: string;
  note?: string;
  date?: string;
  tagIds?: string[];
  projectId?: string;
}

export interface SnackItem {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  duration?: number;
}

export interface ActionItem {
  label: string;
  icon?: string;
  danger?: boolean;
  onSelect: () => void;
}

interface UIState {
  /** 記帳月曆目前選取的日期（新增帳目預設使用此日期） */
  selectedDate: string;
  setSelectedDate: (d: string) => void;

  add: { open: boolean; seq: number; prefill?: AddPrefill; editTxId?: string; editTransferId?: string };
  openAdd: (prefill?: AddPrefill) => void;
  editTx: (id: string) => void;
  editTransfer: (id: string) => void;
  closeAdd: () => void;

  snack: SnackItem | null;
  showSnack: (s: Omit<SnackItem, 'id'>) => void;
  dismissSnack: () => void;

  actions: { title?: string; items: ActionItem[] } | null;
  showActions: (title: string | undefined, items: ActionItem[]) => void;
  closeActions: () => void;
}

let snackSeq = 0;

export const useUI = create<UIState>((set) => ({
  selectedDate: todayKey(),
  setSelectedDate: (d) => set({ selectedDate: d }),

  // seq：每次開啟遞增，讓面板以全新狀態掛載；關閉時保留 seq 以播放退出動畫
  add: { open: false, seq: 0 },
  openAdd: (prefill) => set((s) => ({ add: { open: true, seq: s.add.seq + 1, prefill } })),
  editTx: (id) => set((s) => ({ add: { open: true, seq: s.add.seq + 1, editTxId: id } })),
  editTransfer: (id) => set((s) => ({ add: { open: true, seq: s.add.seq + 1, editTransferId: id } })),
  closeAdd: () => set((s) => ({ add: { ...s.add, open: false } })),

  snack: null,
  showSnack: (s) => set({ snack: { ...s, id: ++snackSeq } }),
  dismissSnack: () => set({ snack: null }),

  actions: null,
  showActions: (title, items) => set({ actions: { title, items } }),
  closeActions: () => set({ actions: null }),
}));

/** 統一的「已刪除・復原」提示 */
export function snackUndo(text: string, undo: () => void | Promise<void>) {
  useUI.getState().showSnack({ text, actionLabel: '復原', onAction: () => void undo(), duration: 5000 });
}

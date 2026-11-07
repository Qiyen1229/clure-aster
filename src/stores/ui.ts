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
  /** 商家（例如電子發票的賣方名稱） */
  merchant?: string;
  /** 電子發票號碼 */
  invoiceNo?: string;
  /** 一句話記帳：開啟時先解析這段文字（深層連結 /add?text=…） */
  quickText?: string;
  /** 從收件匣帶入：儲存後把這則收件匣項目標為已處理 */
  inboxId?: string;
  /** 收件匣的卡片名稱：儲存後記住「這張卡 → 這個帳戶」 */
  inboxCard?: string;
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

  /** 自製確認視窗（取代瀏覽器／iOS 內建的 confirm）：用 askConfirm() 取得使用者的選擇 */
  confirm: ConfirmRequest | null;
  closeConfirm: (ok: boolean) => void;

  /** 自製輸入視窗（取代 window.prompt）：用 askInput() 取得使用者輸入的文字，取消回傳 null */
  input: InputRequest | null;
  closeInput: (value: string | null) => void;

  actions: { title?: string; items: ActionItem[] } | null;
  showActions: (title: string | undefined, items: ActionItem[]) => void;
  closeActions: () => void;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** 確認鍵是破壞性操作（刪除、放棄）：用紅色 */
  danger?: boolean;
}
export interface ConfirmRequest extends ConfirmOptions { id: number; resolve: (ok: boolean) => void }

export interface InputOptions {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  /** 密碼：隱藏輸入、不自動大寫與校正 */
  secret?: boolean;
  /** 一定要填（確認鍵在空白時不能按） */
  required?: boolean;
  danger?: boolean;
  inputMode?: 'text' | 'numeric' | 'decimal';
  maxLength?: number;
}
export interface InputRequest extends InputOptions { id: number; resolve: (value: string | null) => void }

let snackSeq = 0;
let confirmSeq = 0;
let inputSeq = 0;

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

  confirm: null,
  closeConfirm: (ok) => set((s) => { s.confirm?.resolve(ok); return { confirm: null }; }),

  input: null,
  closeInput: (value) => set((s) => { s.input?.resolve(value); return { input: null }; }),

  actions: null,
  showActions: (title, items) => set({ actions: { title, items } }),
  closeActions: () => set({ actions: null }),
}));

/** 統一的「已刪除・復原」提示 */
export function snackUndo(text: string, undo: () => void | Promise<void>) {
  useUI.getState().showSnack({ text, actionLabel: '復原', onAction: () => void undo(), duration: 5000 });
}

/** 自製的確認視窗；回傳 true＝按了確認。同時只會顯示一個，後來的會取代前一個（前一個視為取消） */
export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useUI.getState().confirm?.resolve(false);
    useUI.setState({ confirm: { ...opts, id: ++confirmSeq, resolve } });
  });
}

/** 輸入視窗：回傳使用者輸入的文字（前後空白已去掉），按取消回傳 null。同時只會顯示一個。 */
export function askInput(opts: InputOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useUI.getState().input?.resolve(null);
    useUI.setState({ input: { ...opts, id: ++inputSeq, resolve } });
  });
}

const DANGER_RE = /刪除|移除|撤銷|清除|停用|取代|登出|重設|強制|放棄/;

/**
 * 一句話版的確認視窗（取代 window.confirm）：第一句當標題、其餘當說明；含「刪除、移除、清除…」等字眼時確認鍵用紅色。
 * 用法：`if (!(await ask('刪除這個目標？'))) return;`
 */
export function ask(message: string, opts: Partial<ConfirmOptions> = {}): Promise<boolean> {
  const m = /^([^。？！\n]*[。？！])\s*([\s\S]*)$/.exec(message);
  const title = m ? m[1] : message;
  const rest = m ? m[2].trim() : '';
  const danger = opts.danger ?? DANGER_RE.test(title);
  const confirmText = opts.confirmText ?? (/刪除|移除|撤銷/.test(title) ? '刪除' : /清除/.test(title) ? '清除' : /登出/.test(title) ? '登出' : '確定');
  return askConfirm({ title, message: rest || undefined, danger, confirmText, cancelText: '取消', ...opts });
}

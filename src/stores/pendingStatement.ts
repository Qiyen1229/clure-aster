/**
 * 等著對帳的帳單檔：收件匣裡 Email 轉寄來的附件（CSV 或截圖）按「對帳」後放在這裡，
 * 匯入頁（對帳模式）載入時取走並直接開始；對帳完成後依 inboxId 把那則信從收件匣移除。
 */
import { create } from 'zustand';

interface PendingStatement {
  file: File | null;
  inboxId: number | null;
  set: (file: File, inboxId: number) => void;
}

export const usePendingStatement = create<PendingStatement>((set) => ({
  file: null, inboxId: null,
  set: (file, inboxId) => set({ file, inboxId }),
}));

/** 收件匣待確認數（首頁提示、底部導覽用）。獨立成很小的檔案，避免導覽列為了一個數字載入整個收件匣解析程式 */
import { create } from 'zustand';

export const useInboxCount = create<{ n: number; set: (n: number) => void }>((set) => ({ n: 0, set: (n) => set({ n }) }));

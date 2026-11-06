/** 收件匣待確認數（首頁提示、底部導覽用）。獨立成很小的檔案，避免導覽列為了一個數字載入整個收件匣解析程式 */
import { create } from 'zustand';

/** n：伺服器收件匣的待確認數；extra：本機推算的「預計扣款」與週期帳目待確認數（兩者分開計，各自更新）。顯示用 useInboxTotal */
export const useInboxCount = create<{ n: number; extra: number; set: (n: number) => void; setExtra: (n: number) => void }>((set) => ({
  n: 0, extra: 0, set: (n) => set({ n }), setExtra: (extra) => set({ extra }),
}));

export const useInboxTotal = () => useInboxCount((s) => s.n + s.extra);

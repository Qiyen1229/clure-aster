/**
 * 畫面情境（Screen Context）：App 目前停在哪個畫面、畫面上有什麼重點，讓 AI 對話框「看得到你正在看的東西」。
 *  - routeLabel：由路由自動推得（ScreenContextHost）；detail：頁面自己提供的一句摘要（只有名稱與統計數字，不含單筆帳目、備註）
 *  - 摘要只有在你開啟對話、且沒有按掉「📍 目前畫面」標籤時才會跟著問題一起送出，內容可在「Cilo設定 → 查看送出過什麼」檢查
 */
import { useEffect } from 'react';
import { create } from 'zustand';

interface ScreenState {
  routeLabel: string;
  detail: string | null;
  setRoute: (label: string) => void;
  setDetail: (d: string | null) => void;
}
export const useScreen = create<ScreenState>((set) => ({
  routeLabel: '', detail: null,
  setRoute: (routeLabel) => set({ routeLabel, detail: null }),
  setDetail: (detail) => set({ detail }),
}));

/** 目前畫面的一句話描述（沒有的話是空字串） */
export const currentScreen = (): string => {
  const s = useScreen.getState();
  return (s.detail ?? s.routeLabel).slice(0, 160);
};

/** 頁面提供畫面摘要：離開頁面或摘要變了時自動清掉舊的。傳 null＝這一層沒有摘要要提供（資料還沒載入，或交給子元件提供），不會蓋掉別人設的 */
export function useScreenDetail(detail: string | null): void {
  useEffect(() => {
    if (detail === null) return;
    useScreen.getState().setDetail(detail);
    return () => { if (useScreen.getState().detail === detail) useScreen.getState().setDetail(null); };
  }, [detail]);
}

const ROUTES: [RegExp, string][] = [
  [/^\/(ledger.*)?$/, '首頁・記帳'],
  [/^\/accounts\/[^/]+/, '帳戶詳情'],
  [/^\/accounts/, '帳戶總覽'],
  [/^\/invest\/stock\//, '個股頁'],
  [/^\/invest/, '投資'],
  [/^\/plan\/projects\//, '專案詳情'],
  [/^\/plan/, '專案與預算'],
  [/^\/reports\/fire/, '財務自由試算'],
  [/^\/reports\/tax/, '投資稅務彙總'],
  [/^\/reports\/cashflow/, '現金流預測'],
  [/^\/reports/, '報表'],
  [/^\/settings/, '設定'],
  [/^\/search/, '搜尋'],
  [/^\/ai/, 'Cilo'],
];
export const labelForPath = (pathname: string): string => ROUTES.find(([re]) => re.test(pathname))?.[1] ?? '';

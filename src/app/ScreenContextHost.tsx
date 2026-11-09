/**
 * 依路由更新「目前畫面」標籤（各頁面可再用 useScreenDetail 補上更詳細的一句摘要）。
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { labelForPath, useScreen } from '@/stores/screenContext';
import { useChat } from '@/features/home/aiChatStore';

export function ScreenContextHost() {
  const { pathname, search } = useLocation();
  useEffect(() => { useScreen.getState().setRoute(labelForPath(pathname)); }, [pathname]);
  // 對話視窗開著時只要路由變了（點檢視卡的「完整財務自由試算 →」、稅務卡的連結、對話裡的任何跳轉），就讓視窗自己沉下去，露出目的頁面——
  // 不然視窗蓋在最上面，按鈕看起來像沒反應
  useEffect(() => { useChat.getState().setOpen(false); }, [pathname, search]);
  return null;
}

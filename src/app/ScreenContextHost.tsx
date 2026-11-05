/**
 * 依路由更新「目前畫面」標籤（各頁面可再用 useScreenDetail 補上更詳細的一句摘要）。
 * 另外：開了 AI 的人第一次離開首頁時，輕輕提示一次「中央圓球往上滑就能問 AI」（只提示一次）。
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { labelForPath, useScreen } from '@/stores/screenContext';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';

const TIP_KEY = 'aster.islandTip.v1';

export function ScreenContextHost() {
  const { pathname } = useLocation();
  const aiOn = useSettings((s) => !!s.ai?.enabled);
  const onboarded = useSettings((s) => s.onboarded);
  useEffect(() => { useScreen.getState().setRoute(labelForPath(pathname)); }, [pathname]);
  useEffect(() => {
    if (!aiOn || !onboarded || pathname === '/' || pathname.startsWith('/ai') || pathname.startsWith('/onboarding')) return;
    try {
      if (localStorage.getItem(TIP_KEY)) return;
      localStorage.setItem(TIP_KEY, '1');
    } catch { return; }
    const t = window.setTimeout(() => useUI.getState().showSnack({ text: '💡 中央圓球往上滑（或長按）就能問 AI，它看得到你正在看的畫面', duration: 6000 }), 1200);
    return () => window.clearTimeout(t);
  }, [pathname, aiOn, onboarded]);
  return null;
}

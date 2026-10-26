/**
 * iPhone（尤其加入主畫面後）的畫面尺寸處理：
 *
 * 1. 系統鍵盤：iOS 開鍵盤時不會縮小版面，固定在底部的抽屜會被鍵盤蓋住。
 *    以 visualViewport 算出鍵盤高度寫進 --kb，並在 <html> 加上 kb-open；
 *    抽屜改貼齊鍵盤上緣、記帳面板的自訂數字鍵盤與底部 Tab Bar 暫時隱藏。
 * 2. 文字大小：全 App 的字級都以 rem 計，只要調整 <html> 的根字級。
 *    - 「跟隨系統」：html 使用 -apple-system-body 跟隨 iOS「文字大小」，但「更大的輔助字級」可達 50px 以上，
 *      固定高度的按鈕、鍵盤會被裁切，因此限制在 15–21px（仍涵蓋 iOS 的「小」到「特大」）
 *    - 使用者在「設定 → 外觀 → 文字大小」選的固定大小（FONT_SIZES）
 *    選擇另存一份在 localStorage，登入前（登入頁、解鎖畫面）也用同樣大小，不會閃一下。
 */
import type { FontSizePref } from '@/db/repo/settings';

const MIN_ROOT_PX = 15;
const MAX_ROOT_PX = 21;
const FONT_KEY = 'clure.fontSize';

/** 可選的文字大小（根字級 px）；iPhone 系統預設「標準」為 17px */
export const FONT_SIZES: { px: number; label: string }[] = [
  { px: 15, label: '小' },
  { px: 17, label: '標準' },
  { px: 19, label: '大' },
  { px: 21, label: '特大' },
  { px: 23, label: '超大' },
];

let fontPref: FontSizePref = readCachedPref();

function readCachedPref(): FontSizePref {
  try {
    const v = localStorage.getItem(FONT_KEY);
    const n = Number(v);
    return v && FONT_SIZES.some((f) => f.px === n) ? n : 'system';
  } catch { return 'system'; }
}

/** 套用文字大小設定（設定頁變更、登入後載入設定時呼叫） */
export function setFontSizePreference(pref: FontSizePref | undefined): void {
  fontPref = typeof pref === 'number' && FONT_SIZES.some((f) => f.px === pref) ? pref : 'system';
  try {
    if (fontPref === 'system') localStorage.removeItem(FONT_KEY);
    else localStorage.setItem(FONT_KEY, String(fontPref));
  } catch { /* 私密瀏覽：只套用不記住 */ }
  clampRootFontSize();
}
/** 小於這個高度的差異視為網址列伸縮，不是鍵盤 */
const KEYBOARD_MIN_PX = 120;

export function clampRootFontSize(): void {
  const root = document.documentElement;
  if (fontPref !== 'system') { root.style.fontSize = `${fontPref}px`; return; }
  root.style.fontSize = '';
  const px = parseFloat(getComputedStyle(root).fontSize) || 16;
  if (px > MAX_ROOT_PX) root.style.fontSize = `${MAX_ROOT_PX}px`;
  else if (px < MIN_ROOT_PX) root.style.fontSize = `${MIN_ROOT_PX}px`;
}

export function installViewportTracking(): () => void {
  clampRootFontSize();
  const vv = window.visualViewport;
  const root = document.documentElement;
  let raf = 0;
  const update = () => {
    raf = 0;
    if (!vv) return;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    const open = kb > KEYBOARD_MIN_PX && isTextInput(document.activeElement);
    root.style.setProperty('--kb', open ? `${kb}px` : '0px');
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    root.classList.toggle('kb-open', open);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  // 失焦後鍵盤還在收起中，稍等再量
  const onFocusOut = () => setTimeout(schedule, 50);
  window.addEventListener('focusin', schedule);
  window.addEventListener('focusout', onFocusOut);
  // 回到 App（可能在「設定」改了文字大小）時重新計算字級
  const onVisible = () => { if (document.visibilityState === 'visible') clampRootFontSize(); };
  document.addEventListener('visibilitychange', onVisible);
  update();
  return () => {
    vv?.removeEventListener('resize', schedule);
    vv?.removeEventListener('scroll', schedule);
    window.removeEventListener('focusin', schedule);
    window.removeEventListener('focusout', onFocusOut);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) return true;
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'range', 'file', 'color'].includes(el.type);
  return el instanceof HTMLSelectElement;
}

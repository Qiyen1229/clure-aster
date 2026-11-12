/**
 * 全站觸覺反饋（Haptics）：
 * 依據互動情境提供分層震動回饋（輕微刻度、輕敲、中度確認、成功、警告）。
 * 支援系統減少動態設定與安全降級。
 *
 * 【iOS / Safari 平台相容性說明】
 * Apple WebKit 基於隱私指紋防護考量，在 iOS Safari 與 PWA 獨立視窗中未開放 W3C Vibration API (navigator.vibrate)。
 * 本模組：
 * 1. 於 Android、支援 Vibration API 的瀏覽器透過 navigator.vibrate 觸發硬體震動。
 * 2. 支援 iOS Native App / WKWebView 容器（若有注入 window.webkit.messageHandlers.haptics 則轉發原生物件）。
 * 3. 於純 iOS Web / PWA 環境自動安靜降級，保證無任何例外拋出與效能負擔。
 */

export type HapticStyle = 'selection' | 'light' | 'medium' | 'heavy' | 'success' | 'warning';

export const PATTERNS: Record<HapticStyle, number | number[]> = {
  selection: 4,
  light: 8,
  medium: 14,
  heavy: 22,
  success: [8, 40, 14],
  warning: [16, 40, 16],
};

let lastTick = 0;

/** 檢查當前運行環境是否具備震動或觸覺回饋硬體 API */
export function isHapticsSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (typeof navigator.vibrate === 'function') return true;
  if (typeof (window as any).webkit?.messageHandlers?.haptics?.postMessage === 'function') return true;
  return false;
}

export function haptic(style: HapticStyle = 'light'): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  const now = performance.now();
  // 防止連續高頻觸發造成震動黏連（至少間隔 18ms）
  if (style === 'selection' && now - lastTick < 18) return;
  lastTick = now;

  try {
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(PATTERNS[style]);
      return;
    }
    // 支援 iOS Native 殼（WKWebView Message Handler）
    const webkitHaptics = (window as any).webkit?.messageHandlers?.haptics;
    if (typeof webkitHaptics?.postMessage === 'function') {
      webkitHaptics.postMessage({ style });
    }
  } catch {
    /* 忽略不支援環境（例如 iOS Safari 純 Web） */
  }
}

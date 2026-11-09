/**
 * 全站觸覺反饋（Haptics）：
 * 依據互動情境提供分層震動回饋（輕微刻度、輕敲、中度確認、成功、警告）。
 * 支援系統減少動態設定與安全降級。
 */

export type HapticStyle = 'selection' | 'light' | 'medium' | 'heavy' | 'success' | 'warning';

const PATTERNS: Record<HapticStyle, number | number[]> = {
  selection: 4,
  light: 8,
  medium: 14,
  heavy: 22,
  success: [8, 40, 14],
  warning: [16, 40, 16],
};

let lastTick = 0;

export function haptic(style: HapticStyle = 'light'): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  const now = performance.now();
  // 防止連續高頻觸發造成震動黏連（至少間隔 18ms）
  if (style === 'selection' && now - lastTick < 18) return;
  lastTick = now;

  try {
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(PATTERNS[style]);
    }
  } catch {
    /* 忽略不支援環境 */
  }
}

/**
 * 偵測／預警功能的使用次數限制（5 分鐘最多 10 次，各功能分開計）。
 * 時間戳記存在這台裝置的 localStorage；讀寫失敗（私密瀏覽等）時退回記憶體，限制仍然有效，只是重新整理後會歸零。
 */
import { MAX_USES, peek, tryUse, waitText, type LimitResult } from '@/domain/usagelimit';

export type LimitKey = 'insight-anomaly' | 'insight-budget';
const mem = new Map<string, number[]>();
const storeKey = (k: LimitKey) => `aster.usage.${k}`;

function read(k: LimitKey): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(k)) ?? '[]');
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'number');
  } catch { /* 用記憶體 */ }
  return mem.get(k) ?? [];
}
function write(k: LimitKey, stamps: number[]) {
  mem.set(k, stamps);
  try { localStorage.setItem(storeKey(k), JSON.stringify(stamps)); } catch { /* 忽略 */ }
}

/** 使用一次；超過限制時回傳 ok=false 與要等多久（不會寫入） */
export function consume(k: LimitKey, now = Date.now()): LimitResult & { message: string } {
  const r = tryUse(read(k), now);
  if (r.ok) write(k, r.stamps);
  return { ...r, message: r.ok ? '' : `5 分鐘內已使用 ${MAX_USES} 次，請等${waitText(r.retryAfterMs)}後再試` };
}

export const remaining = (k: LimitKey, now = Date.now()) => peek(read(k), now).remaining;

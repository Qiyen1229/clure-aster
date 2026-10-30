/**
 * 使用次數限制（純函式）：滑動時間窗。
 * 「異常與訂閱偵測」「預算預警」的白話說明與手動重新偵測，5 分鐘內最多 10 次；
 * 它們都在本機用規則計算、不呼叫 AI，也不計入 AI 額度——這個限制只是避免連點把裝置算到發燙。
 */
export const WINDOW_MS = 5 * 60_000;
export const MAX_USES = 10;

export interface LimitResult {
  ok: boolean;
  /** 還要等多久才能再用（毫秒；ok 時為 0） */
  retryAfterMs: number;
  /** 這個時間窗內還剩幾次 */
  remaining: number;
  /** 更新後的時間戳記（只有 ok 時才會多一筆） */
  stamps: number[];
}

/** 嘗試使用一次。stamps 是過去的使用時間（毫秒），不必排序、可含過期的 */
export function tryUse(stamps: number[], now: number, max = MAX_USES, windowMs = WINDOW_MS): LimitResult {
  const live = stamps.filter((t) => Number.isFinite(t) && t > now - windowMs && t <= now + 1000).sort((a, b) => a - b);
  if (live.length >= max) {
    const retryAfterMs = Math.max(1, live[live.length - max] + windowMs - now);
    return { ok: false, retryAfterMs, remaining: 0, stamps: live };
  }
  const next = [...live, now];
  return { ok: true, retryAfterMs: 0, remaining: max - next.length, stamps: next };
}

/** 不消耗次數，只看現在還剩幾次 */
export function peek(stamps: number[], now: number, max = MAX_USES, windowMs = WINDOW_MS): { remaining: number; retryAfterMs: number } {
  const live = stamps.filter((t) => t > now - windowMs && t <= now + 1000).sort((a, b) => a - b);
  return live.length >= max
    ? { remaining: 0, retryAfterMs: Math.max(1, live[live.length - max] + windowMs - now) }
    : { remaining: max - live.length, retryAfterMs: 0 };
}

export const waitText = (ms: number) => (ms >= 60_000 ? `約 ${Math.ceil(ms / 60_000)} 分鐘` : `${Math.max(1, Math.ceil(ms / 1000))} 秒`);

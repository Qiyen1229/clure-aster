import { describe, expect, it } from 'vitest';
import { MAX_USES, WINDOW_MS, peek, tryUse, waitText } from '@/domain/usagelimit';

describe('5 分鐘最多 10 次', () => {
  it('前 10 次通過、第 11 次被擋，並告知要等多久', () => {
    let stamps: number[] = [];
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_USES; i++) {
      const r = tryUse(stamps, t0 + i * 1000);
      expect(r.ok).toBe(true);
      expect(r.remaining).toBe(MAX_USES - 1 - i);
      stamps = r.stamps;
    }
    const blocked = tryUse(stamps, t0 + 10_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    // 最早那一次（t0）滿 5 分鐘後就空出一個名額
    expect(blocked.retryAfterMs).toBe(t0 + WINDOW_MS - (t0 + 10_000));
    expect(blocked.stamps).toHaveLength(MAX_USES); // 被擋的不會寫入
  });
  it('滑動窗：最早的一次過期後可以再用', () => {
    const t0 = 5_000_000;
    let stamps: number[] = [];
    for (let i = 0; i < MAX_USES; i++) stamps = tryUse(stamps, t0 + i).stamps;
    expect(tryUse(stamps, t0 + WINDOW_MS - 1).ok).toBe(false);
    expect(tryUse(stamps, t0 + WINDOW_MS + 1).ok).toBe(true);
  });
  it('過期、不合理的時間戳記會被忽略；peek 不消耗次數', () => {
    const now = 10_000_000;
    expect(peek([now - WINDOW_MS - 1, NaN as number, now + 9_999_999], now).remaining).toBe(MAX_USES);
    expect(peek([now - 1000, now - 2000], now).remaining).toBe(MAX_USES - 2);
  });
  it('等待時間文字', () => {
    expect(waitText(1500)).toBe('2 秒');
    expect(waitText(61_000)).toBe('約 2 分鐘');
  });
});

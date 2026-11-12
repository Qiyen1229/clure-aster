import { describe, it, expect } from 'vitest';
import { UpdatePromptManager } from '@/services/appUpdate';

describe('UpdatePromptManager', () => {
  it('未有更新時不提示', () => {
    const mgr = new UpdatePromptManager();
    expect(mgr.shouldShow()).toBe(false);
  });

  it('有更新時正常提示', () => {
    const mgr = new UpdatePromptManager();
    mgr.setPendingUpdate(true);
    expect(mgr.shouldShow()).toBe(true);
  });

  it('點擊稍後後不再立即提示，直到間隔或回到前景', () => {
    const mgr = new UpdatePromptManager(6 * 60 * 60 * 1000); // 6 hours
    mgr.setPendingUpdate(true);
    expect(mgr.shouldShow()).toBe(true);

    const now = 1000000;
    mgr.dismiss(now);
    // 立即檢查：不提示
    expect(mgr.shouldShow(now + 1000)).toBe(false);
    // 1 小時後檢查：仍不提示
    expect(mgr.shouldShow(now + 3600 * 1000)).toBe(false);

    // 間隔 6 小時到達：重新提示
    expect(mgr.onInterval(now + 6 * 3600 * 1000)).toBe(true);
    expect(mgr.shouldShow(now + 6 * 3600 * 1000)).toBe(true);

    // 再次點擊稍後
    mgr.dismiss(now + 6 * 3600 * 1000);
    expect(mgr.shouldShow(now + 6 * 3600 * 1000 + 1000)).toBe(false);

    // 下次回景（onForeground）：重新提示
    expect(mgr.onForeground()).toBe(true);
    expect(mgr.shouldShow()).toBe(true);
  });
});

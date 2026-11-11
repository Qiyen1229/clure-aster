/**
 * 回到前景刷新收件匣：startAutoRefresh 的 visibilitychange 處理。
 * 收件匣 30 秒節流（不等 10 分鐘補算）、隱藏時不刷、短時間內重複切換不重複抓。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refreshInbox: vi.fn(async () => undefined) }));
vi.mock('@/services/inbox', () => mocks);

import { startAutoRefresh } from '@/services/startup';

let now = 1_000_000;
let visibility: 'visible' | 'hidden' = 'visible';
const listeners = new Set<() => void>();
const fire = () => { for (const fn of [...listeners]) fn(); };
const flush = () => new Promise((r) => setTimeout(r, 0));

let stop: (() => void) | undefined;
beforeEach(() => {
  now = 1_000_000;
  visibility = 'visible';
  listeners.clear();
  mocks.refreshInbox.mockClear();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('document', {
    get visibilityState() { return visibility; },
    addEventListener: (ev: string, fn: () => void) => { if (ev === 'visibilitychange') listeners.add(fn); },
    removeEventListener: (ev: string, fn: () => void) => { if (ev === 'visibilitychange') listeners.delete(fn); },
  });
  vi.stubGlobal('navigator', { onLine: true });
  stop = startAutoRefresh();
});
afterEach(() => {
  stop?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('回到前景刷新收件匣', () => {
  it('啟動後 30 秒內不重複抓；超過 30 秒回到前景就抓一次', async () => {
    fire();
    await flush();
    expect(mocks.refreshInbox).not.toHaveBeenCalled();
    now += 31_000;
    fire();
    await flush();
    expect(mocks.refreshInbox).toHaveBeenCalledTimes(1);
    fire();
    await flush();
    expect(mocks.refreshInbox).toHaveBeenCalledTimes(1);
    now += 31_000;
    fire();
    await flush();
    expect(mocks.refreshInbox).toHaveBeenCalledTimes(2);
  });

  it('隱藏時不抓；回到可見就抓（不受 10 分鐘補算節流限制）', async () => {
    now += 31_000;
    visibility = 'hidden';
    fire();
    await flush();
    expect(mocks.refreshInbox).not.toHaveBeenCalled();
    visibility = 'visible';
    fire();
    await flush();
    expect(mocks.refreshInbox).toHaveBeenCalledTimes(1);
  });
});
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { deviceFromUA } from '@/services/devices';
import { readFails, readFailsSync, writeFails, WIPE_AT } from '@/services/lockGuard';
import { lockoutMs } from '@/app/LockScreen';

const store = new Map<string, string>();
beforeEach(async () => {
  store.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  await db.meta.clear();
});

describe('登入裝置名稱', () => {
  it('依 User-Agent 顯示「系統 · 瀏覽器」', () => {
    expect(deviceFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(deviceFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36')).toBe('Mac · Chrome');
    expect(deviceFromUA('Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/130.0')).toBe('Windows · Firefox');
    expect(deviceFromUA('pytest')).toBe('未知裝置');
  });
});

describe('PIN 錯誤次數：localStorage 與 IndexedDB 兩邊保存', () => {
  it('寫入兩邊；只清掉 localStorage 重置不了（讀取取較大的次數與較晚的等待時間）', async () => {
    await writeFails(6, 123456);
    expect(readFailsSync()).toEqual({ fails: 6, until: 123456 });
    expect((await db.meta.get('lock.fails'))?.value).toEqual({ fails: 6, until: 123456 });
    store.clear(); // 有心人在電腦上刪掉 localStorage 的 clure.lock.fails
    expect(readFailsSync()).toEqual({ fails: 0, until: 0 });
    expect(await readFails()).toEqual({ fails: 6, until: 123456 });
  });
  it('解鎖成功（次數歸零）兩邊都清掉；兩邊不一致時取大的', async () => {
    await writeFails(3, 10);
    store.set('clure.lock.fails', JSON.stringify({ fails: 8, until: 99 }));
    expect(await readFails()).toEqual({ fails: 8, until: 99 });
    await writeFails(0, 0);
    expect(await readFails()).toEqual({ fails: 0, until: 0 });
    expect(await db.meta.get('lock.fails')).toBeUndefined();
  });
  it('連錯 10 次的門檻與等待時間規則', () => {
    expect(WIPE_AT).toBe(10);
    expect(lockoutMs(4)).toBe(0);
    expect(lockoutMs(5)).toBe(30_000);
    expect(lockoutMs(6)).toBe(60_000);
    expect(lockoutMs(20)).toBe(3_600_000);
  });
});

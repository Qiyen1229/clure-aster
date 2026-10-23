import { describe, expect, it } from 'vitest';
import { hashPin, setPin, verifyPin } from '@/services/lock';
import { computeSplit } from '@/features/add/SplitSheet';

// 測試環境沒有 DOM／IndexedDB：模擬設定儲存
import { vi } from 'vitest';
const store: Record<string, any> = { lock: { enabled: false, pinHash: '', salt: '', iterations: 1000, webauthn: null, autoLockSec: 60 } };
vi.mock('@/stores/settings', () => ({
  useSettings: { getState: () => ({ ...store, set: (k: string, v: unknown) => { store[k] = v; } }) },
}));

describe('App 鎖 PIN', () => {
  it('PBKDF2 雜湊：同 salt 結果一致、不同 PIN 不同', async () => {
    const salt = btoa('0123456789abcdef');
    expect(await hashPin('123456', salt, 1000)).toBe(await hashPin('123456', salt, 1000));
    expect(await hashPin('123456', salt, 1000)).not.toBe(await hashPin('123457', salt, 1000));
  });
  it('設定後只接受正確 PIN', async () => {
    await setPin('246810');
    expect(store.lock.enabled).toBe(true);
    expect(store.lock.pinHash).not.toContain('246810');
    expect(await verifyPin('246810')).toBe(true);
    expect(await verifyPin('000000')).toBe(false);
  });
});

describe('分帳拆分', () => {
  it('平均分含自己，總和不變', () => {
    const r = computeSplit(100000, { mode: 'equal', people: [{ name: 'A', amount: '' }, { name: 'B', amount: '' }] }, 'TWD');
    expect(r.myShare + r.shares.reduce((a, s) => a + s.minor, 0)).toBe(100000);
    expect(r.myShare).toBe(33334);
  });
  it('自訂金額與超額檢查', () => {
    expect(computeSplit(100000, { mode: 'custom', people: [{ name: 'A', amount: '300' }] }, 'TWD')).toMatchObject({ myShare: 70000 });
    expect(computeSplit(100000, { mode: 'custom', people: [{ name: 'A', amount: '1200' }] }, 'TWD').error).toBeTruthy();
  });
});

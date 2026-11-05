import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('__APP_VERSION__', '4.0.4');

describe('新功能標記', () => {
  it('只有「最新一批新功能」那一版會亮；新一批出現後舊的自動熄掉', async () => {
    const { isNewFeature } = await import('@/ui/NewMark');
    expect(isNewFeature('4.0.0', '4.0.0')).toBe(true);
    expect(isNewFeature('4.0.0', '4.1.0')).toBe(false); // 4.1.0 有新功能：4.0.0 的標記熄掉
    expect(isNewFeature('4.1.0', '4.1.0')).toBe(true);
    const { FEATURE_RELEASE } = await import('@/release');
    expect(isNewFeature(FEATURE_RELEASE)).toBe(true);
  });
});

describe('自製確認視窗', () => {
  it('askConfirm 回傳使用者的選擇；新的會取代舊的（舊的視為取消）', async () => {
    const { askConfirm, useUI } = await import('@/stores/ui');
    const a = askConfirm({ title: '放棄？', danger: true });
    expect(useUI.getState().confirm?.title).toBe('放棄？');
    useUI.getState().closeConfirm(true);
    expect(await a).toBe(true);
    expect(useUI.getState().confirm).toBeNull();
    const b = askConfirm({ title: 'B' });
    const c = askConfirm({ title: 'C' });
    expect(await b).toBe(false);
    useUI.getState().closeConfirm(false);
    expect(await c).toBe(false);
  });
});

describe('更新後「有新功能可用」通知', () => {
  it('這批新功能還沒看過就通知一次；之後不再；全新安裝（未完成引導）不通知', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    const { db } = await import('@/db/schema');
    const { useSettings } = await import('@/stores/settings');
    const { DEFAULT_SETTINGS } = await import('@/db/repo/settings');
    const { announceNewFeatures } = await import('@/services/startup');
    await db.open(); await db.reminders.clear();
    useSettings.setState({ ...DEFAULT_SETTINGS, onboarded: false } as never);
    await announceNewFeatures(); // 全新安裝：只記下已看過，不通知
    expect(await db.reminders.count()).toBe(0);
    store.clear();
    useSettings.setState({ ...DEFAULT_SETTINGS, onboarded: true } as never);
    await announceNewFeatures();
    const rows = await db.reminders.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain('✨ 有新功能可用');
    await announceNewFeatures(); // 同一批不重複
    expect(await db.reminders.count()).toBe(1);
  });
});

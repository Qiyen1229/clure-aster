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

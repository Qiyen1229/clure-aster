import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('__APP_VERSION__', '4.0.1');

describe('新功能標記', () => {
  it('同一版與之後兩個次版本內顯示，更久之後自動消失；未來版本不顯示', async () => {
    const { isNewFeature } = await import('@/ui/NewMark');
    expect(isNewFeature('4.0.0', '4.0.1')).toBe(true);
    expect(isNewFeature('4.0.0', '4.2.0')).toBe(true);
    expect(isNewFeature('4.0.0', '4.3.0')).toBe(false);
    expect(isNewFeature('4.0.0', '5.0.0')).toBe(false);
    expect(isNewFeature('4.1.0', '4.0.1')).toBe(false);
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

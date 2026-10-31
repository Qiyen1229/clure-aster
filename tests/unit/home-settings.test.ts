import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { DEFAULT_SETTINGS, loadSettings } from '@/db/repo/settings';

describe('首頁簡潔版的設定', () => {
  beforeEach(async () => { await db.settings.clear(); });

  it('預設：週曆收合、首頁不放小工具', () => {
    expect(DEFAULT_SETTINGS.calendarCollapsed).toBe(true);
    expect(DEFAULT_SETTINGS.homeWidgets).toEqual([]);
    expect(DEFAULT_SETTINGS.homeAiChat).toBe(true); // AI 小圓球預設顯示
  });
  it('舊的預設小工具組合（沒自己調整過）升級後不再顯示；自己調整過的維持原樣', async () => {
    await db.settings.put({ key: 'homeWidgets', value: ['today', 'budget', 'networth', 'invest', 'bills'] });
    expect((await loadSettings()).homeWidgets).toEqual([]);
    await db.settings.put({ key: 'homeWidgets', value: ['networth', 'bills'] });
    expect((await loadSettings()).homeWidgets).toEqual(['networth', 'bills']);
  });
  it('已經選過展開整月的人維持自己的選擇', async () => {
    await db.settings.put({ key: 'calendarCollapsed', value: false });
    expect((await loadSettings()).calendarCollapsed).toBe(false);
  });
});

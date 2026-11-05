import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { DEFAULT_SETTINGS, loadSettings } from '@/db/repo/settings';

describe('首頁簡潔版的設定', () => {
  beforeEach(async () => { await db.settings.clear(); await db.meta.delete('homeWidgetsRestored'); });

  it('預設：週曆收合、首頁放回快覽（今日可用、預算、淨資產）', () => {
    expect(DEFAULT_SETTINGS.calendarCollapsed).toBe(true);
    expect(DEFAULT_SETTINGS.homeWidgets).toEqual(['today', 'budget', 'networth']);
    expect(DEFAULT_SETTINGS.homeAiChat).toBe(true); // AI 小圓球預設顯示
  });
  it('4.1.1：之前被存成空的補上預設快覽（只一次）；自己選過的維持原樣；補過之後自己關掉就維持空的', async () => {
    await db.settings.put({ key: 'homeWidgets', value: [] });
    expect((await loadSettings()).homeWidgets).toEqual(['today', 'budget', 'networth']);
    await db.settings.put({ key: 'homeWidgets', value: [] }); // 使用者之後自己把快覽全部關掉
    expect((await loadSettings()).homeWidgets).toEqual([]);
    await db.settings.put({ key: 'homeWidgets', value: ['networth', 'bills'] });
    expect((await loadSettings()).homeWidgets).toEqual(['networth', 'bills']);
  });
  it('已經選過展開整月的人維持自己的選擇', async () => {
    await db.settings.put({ key: 'calendarCollapsed', value: false });
    expect((await loadSettings()).calendarCollapsed).toBe(false);
  });
});

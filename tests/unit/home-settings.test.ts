import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { DEFAULT_SETTINGS, loadSettings, normalizeThemePalette, type ThemePalette } from '@/db/repo/settings';

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

const paletteCases: [unknown, ThemePalette][] = [
  ['default', 'default'],
  ['graphite', 'graphite'],
  ['jade', 'jade'],
  ['amber', 'amber'],
  ['oled', 'graphite'],
  ['slate', 'graphite'],
  ['ocean', 'graphite'],
  ['forest', 'jade'],
  ['oat', 'amber'],
  [undefined, 'default'],
  [null, 'default'],
  ['', 'default'],
  ['unknown', 'default'],
  ['Graphite', 'default'],
  [' jade ', 'default'],
  ['__proto__', 'default'],
  ['constructor', 'default'],
  ['toString', 'default'],
  [0, 'default'],
  [false, 'default'],
  [{ palette: 'jade' }, 'default'],
  [['amber'], 'default'],
];

describe('主題偏好相容性', () => {
  beforeEach(async () => {
    await db.settings.clear();
    // 排除既有首頁快覽的一次性遷移，只驗證主題載入不寫回設定。
    await db.meta.put({ key: 'homeWidgetsRestored', value: 1 });
  });

  it.each(paletteCases)('normalizeThemePalette(%j) → %s', (value, expected) => {
    expect(normalizeThemePalette(value)).toBe(expected);
  });

  it.each(paletteCases)('載入 %j → %s，只在記憶體轉換且保留原始設定', async (value, expected) => {
    await db.settings.bulkPut([
      { key: 'themePalette', value },
      { key: 'theme', value: 'dark' },
      { key: 'accent', value: 'purple' },
      { key: 'upColor', value: 'red' },
      { key: 'fontSize', value: 19 },
      { key: 'calendarCollapsed', value: false },
      { key: 'homeWidgets', value: ['networth', 'bills'] },
      { key: 'quote', value: { refreshSec: 120 } },
    ]);
    const before = await db.settings.toArray();
    // Dexie hooks 也能抓到「寫入相同值」：不能只比較 DB 最終內容。
    const write = vi.fn();
    db.settings.hook('creating', write);
    db.settings.hook('updating', write);
    db.settings.hook('deleting', write);
    try {
      const loaded = await loadSettings();
      expect(loaded).toMatchObject({
        themePalette: expected,
        theme: 'dark',
        accent: 'purple',
        upColor: 'red',
        fontSize: 19,
        calendarCollapsed: false,
        homeWidgets: ['networth', 'bills'],
        quote: { ...DEFAULT_SETTINGS.quote, refreshSec: 120 },
      });
      expect(await loadSettings()).toEqual(loaded);
      expect(await db.settings.toArray()).toEqual(before);
      expect(write).not.toHaveBeenCalled();
    } finally {
      db.settings.hook('creating').unsubscribe(write);
      db.settings.hook('updating').unsubscribe(write);
      db.settings.hook('deleting').unsubscribe(write);
    }
  });

  it('尚未保存主題偏好時使用 default，不新增任何設定列', async () => {
    expect(DEFAULT_SETTINGS.themePalette).toBe('default');
    expect((await loadSettings()).themePalette).toBe('default');
    expect(await db.settings.toArray()).toEqual([]);
  });
});

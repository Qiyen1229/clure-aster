// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settingsRepo from '@/db/repo/settings';
import { DEFAULT_SETTINGS, type Settings, type ThemePalette } from '@/db/repo/settings';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const media = Object.assign(new EventTarget(), {
  matches: false,
  media: DARK_QUERY,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
});

const palettes = [
  { palette: 'default', light: '#f1f2f3', dark: '#111213' },
  { palette: 'graphite', light: '#e1e2e3', dark: '#212223' },
  { palette: 'jade', light: '#e1f2e3', dark: '#213223' },
  { palette: 'amber', light: '#f1e2d3', dark: '#312213' },
] as const;

let applyTheme: typeof import('@/stores/settings')['applyTheme'];
let useSettings: typeof import('@/stores/settings')['useSettings'];
let style: HTMLStyleElement;
let metas: HTMLMetaElement[];

beforeAll(async () => {
  // settings 在模組載入時捕捉 MediaQueryList，必須先 stub 再 dynamic import。
  vi.stubGlobal('matchMedia', vi.fn((query: string) => {
    expect(query).toBe(DARK_QUERY);
    return media;
  }));
  // viewport 會快取字級；部分 Node / jsdom 組合沒有可用的 global localStorage。
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  } satisfies Storage);
  ({ applyTheme, useSettings } = await import('@/stores/settings'));
});

beforeEach(() => {
  media.matches = false;
  useSettings.setState({ ...structuredClone(DEFAULT_SETTINGS), ready: false });
  vi.spyOn(settingsRepo, 'saveSetting').mockResolvedValue(undefined);
  style = document.createElement('style');
  // 用不同於產品的色票，確保 meta 取自 CSS 而非另一份硬編碼。
  style.textContent = `
    :root { font-size: 17px; }
    ${palettes.map(({ palette, light, dark }) => `
      :root[data-palette='${palette}'][data-theme='light'] { --bg: ${light}; }
      :root[data-palette='${palette}'][data-theme='dark'] { --bg: ${dark}; }
    `).join('\n')}
  `;
  metas = ['light', 'dark'].map((theme) => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.media = `(prefers-color-scheme: ${theme})`;
    meta.content = '#ffffff';
    return meta;
  });
  document.head.append(style, ...metas);
});

afterEach(() => {
  style.remove();
  metas.forEach((meta) => meta.remove());
  for (const name of ['data-theme', 'data-palette', 'data-accent', 'data-updown', 'style']) {
    document.documentElement.removeAttribute(name);
  }
  localStorage.removeItem('clure.fontSize');
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function expectMetaColor(color: string) {
  expect(metas.map((meta) => meta.content)).toEqual([color, color]);
}

function changeSystemTheme(dark: boolean) {
  media.matches = dark;
  media.dispatchEvent(Object.assign(new Event('change'), { matches: dark, media: DARK_QUERY }));
}

describe('applyTheme', () => {
  it.each(palettes.flatMap(({ palette, light, dark }) => [
    { palette, theme: 'light' as const, expected: light },
    { palette, theme: 'dark' as const, expected: dark },
  ]))('$palette / $theme：設定四種 data 屬性並同步兩個 theme-color meta', ({ palette, theme, expected }) => {
    const input = Object.freeze({ theme, themePalette: palette, accent: 'purple' as const, upColor: 'red' as const });
    // 手動模式必須忽略相反的系統偏好。
    media.matches = theme === 'light';
    applyTheme(input);
    expect(document.documentElement.dataset).toMatchObject({
      theme,
      palette,
      accent: 'purple',
      updown: 'red',
    });
    expect(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()).toBe(expected);
    expectMetaColor(expected);
    expect(settingsRepo.saveSetting).not.toHaveBeenCalled();
  });

  it('每次套用都重新讀取 --bg，並去除首尾空白', () => {
    const input: Settings = { ...structuredClone(DEFAULT_SETTINGS), theme: 'dark', themePalette: 'jade' };
    applyTheme(input);
    expectMetaColor('#213223');
    document.documentElement.style.setProperty('--bg', '  #abcdef \n ');
    applyTheme(input);
    expectMetaColor('#abcdef');
  });

  it('沒有 themePalette 時使用 default，保留 accent 與收支配色', () => {
    applyTheme({ theme: 'light', accent: 'gold', upColor: 'green' });
    expect(document.documentElement.dataset).toMatchObject({ theme: 'light', palette: 'default', accent: 'gold', updown: 'green' });
    expectMetaColor('#f1f2f3');
  });
});

describe('hydrate 主題偏好', () => {
  const cases: [unknown, ThemePalette][] = [
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
    ['unknown', 'default'],
  ];

  it.each(cases)('%j → %s，套用新主題但不改其他設定或輸入物件', (value, expected) => {
    // 模擬舊備份／同步資料尚未通過 normalize 的邊界輸入。
    const input = {
      ...structuredClone(DEFAULT_SETTINGS),
      themePalette: value,
      theme: 'light',
      accent: 'purple',
      upColor: 'red',
      fontSize: 19,
      locale: 'en',
      hideAmounts: true,
      calendarCollapsed: false,
      homeWidgets: ['bills', 'networth'],
      quote: { ...structuredClone(DEFAULT_SETTINGS.quote), refreshSec: 120 },
      notify: { ...DEFAULT_SETTINGS.notify, dailyTime: '19:45' },
    } as Settings;
    const before = structuredClone(input);
    useSettings.getState().hydrate(input);
    expect(useSettings.getState()).toEqual({
      ...before,
      themePalette: expected,
      ready: true,
      hydrate: expect.any(Function),
      set: expect.any(Function),
    });
    expect(input).toEqual(before);
    expect(document.documentElement.dataset).toMatchObject({ theme: 'light', palette: expected, accent: 'purple', updown: 'red' });
    expectMetaColor(palettes.find(({ palette }) => palette === expected)!.light);
    expect(document.documentElement.style.fontSize).toBe('19px');
    expect(settingsRepo.saveSetting).not.toHaveBeenCalled();
  });

  it('缺少 themePalette 的舊設定也會在 store 補上 default', () => {
    const input = structuredClone(DEFAULT_SETTINGS);
    delete input.themePalette;
    useSettings.setState({ themePalette: 'jade' });
    useSettings.getState().hydrate(input);
    expect(useSettings.getState().themePalette).toBe('default');
    expect(document.documentElement.dataset.palette).toBe('default');
    expect(input).not.toHaveProperty('themePalette');
    expect(settingsRepo.saveSetting).not.toHaveBeenCalled();
  });

  it.each(['graphite', 'jade', 'amber'] as const)('切到 %s 再回 default，仍使用保存的 accent 偏好', (palette) => {
    useSettings.getState().hydrate({ ...structuredClone(DEFAULT_SETTINGS), theme: 'light', accent: 'pink', upColor: 'red' });
    useSettings.getState().set('themePalette', palette);
    expect(useSettings.getState()).toMatchObject({ themePalette: palette, accent: 'pink', upColor: 'red' });
    expect(document.documentElement.dataset).toMatchObject({ palette, accent: 'pink', updown: 'red' });
    useSettings.getState().set('themePalette', 'default');
    expect(useSettings.getState()).toMatchObject({ themePalette: 'default', accent: 'pink', upColor: 'red' });
    expect(document.documentElement.dataset).toMatchObject({ palette: 'default', accent: 'pink', updown: 'red' });
    expect(settingsRepo.saveSetting).toHaveBeenCalledTimes(2);
    expect(settingsRepo.saveSetting).toHaveBeenNthCalledWith(1, 'themePalette', palette);
    expect(settingsRepo.saveSetting).toHaveBeenNthCalledWith(2, 'themePalette', 'default');
  });
});

describe('非外觀設定', () => {
  it('寫入提醒偏好不讀取畫面樣式，保留目前主題', () => {
    useSettings.getState().hydrate({ ...structuredClone(DEFAULT_SETTINGS), theme: 'dark', themePalette: 'jade' });
    const readStyle = vi.spyOn(globalThis, 'getComputedStyle');
    const insights = { ...DEFAULT_SETTINGS.insights, anomaly: false };
    useSettings.getState().set('insights', insights);
    expect(readStyle).not.toHaveBeenCalled();
    expect(settingsRepo.saveSetting).toHaveBeenCalledWith('insights', insights);
    expect(document.documentElement.dataset).toMatchObject({ theme: 'dark', palette: 'jade' });
    expectMetaColor('#213223');
  });
});

describe('系統深淺色事件', () => {
  it.each([false, true])('system 模式載入當前 matches=%s，之後雙向跟隨 change', (initialDark) => {
    media.matches = initialDark;
    useSettings.getState().hydrate({ ...structuredClone(DEFAULT_SETTINGS), theme: 'system', themePalette: 'jade' });
    expect(document.documentElement.dataset.theme).toBe(initialDark ? 'dark' : 'light');
    expectMetaColor(initialDark ? '#213223' : '#e1f2e3');
    for (const dark of [!initialDark, initialDark]) {
      changeSystemTheme(dark);
      expect(document.documentElement.dataset).toMatchObject({ theme: dark ? 'dark' : 'light', palette: 'jade' });
      expectMetaColor(dark ? '#213223' : '#e1f2e3');
      expect(useSettings.getState().theme).toBe('system');
    }
    expect(settingsRepo.saveSetting).not.toHaveBeenCalled();
    // 事件必須讀取最新 store，而不是捕捉 hydrate 時的 palette。
    useSettings.getState().set('themePalette', 'amber');
    changeSystemTheme(!initialDark);
    expect(document.documentElement.dataset.palette).toBe('amber');
    expectMetaColor(initialDark ? '#f1e2d3' : '#312213');
    expect(settingsRepo.saveSetting).toHaveBeenCalledTimes(1);
    expect(settingsRepo.saveSetting).toHaveBeenCalledWith('themePalette', 'amber');
  });

  it.each(['light', 'dark'] as const)('手動 %s 優先於 system change；改回 system 後才跟隨', (theme) => {
    media.matches = theme === 'light';
    useSettings.getState().hydrate({ ...structuredClone(DEFAULT_SETTINGS), theme, themePalette: 'graphite' });
    for (const dark of [!media.matches, media.matches]) {
      changeSystemTheme(dark);
      expect(document.documentElement.dataset.theme).toBe(theme);
      expectMetaColor(theme === 'dark' ? '#212223' : '#e1e2e3');
      expect(useSettings.getState().theme).toBe(theme);
    }
    expect(settingsRepo.saveSetting).not.toHaveBeenCalled();
    useSettings.getState().set('theme', 'system');
    expect(document.documentElement.dataset.theme).toBe(media.matches ? 'dark' : 'light');
    expectMetaColor(media.matches ? '#212223' : '#e1e2e3');
    changeSystemTheme(!media.matches);
    expect(document.documentElement.dataset.theme).toBe(media.matches ? 'dark' : 'light');
    expectMetaColor(media.matches ? '#212223' : '#e1e2e3');
    expect(settingsRepo.saveSetting).toHaveBeenCalledTimes(1);
    expect(settingsRepo.saveSetting).toHaveBeenCalledWith('theme', 'system');
  });
});

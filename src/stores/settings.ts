/**
 * 設定狀態：啟動時從 IndexedDB 載入一次，之後寫入時同步更新記憶體與 DB。
 * 主題相關設定會即時套用到 <html> 的 data-* 屬性。
 */
import { create } from 'zustand';
import { DEFAULT_SETTINGS, normalizeThemePalette, saveSetting, type Settings } from '@/db/repo/settings';
import { setFontSizePreference } from '@/app/viewport';

interface SettingsState extends Settings {
  ready: boolean;
  hydrate: (s: Settings) => void;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export const useSettings = create<SettingsState>((set) => ({
  ...DEFAULT_SETTINGS,
  ready: false,
  hydrate: (s) => {
    const settings = { ...s, themePalette: normalizeThemePalette(s.themePalette) };
    set({ ...settings, ready: true });
    applyTheme(settings);
    setFontSizePreference(s.fontSize);
  },
  set: (key, value) => {
    set({ [key]: value } as Partial<SettingsState>);
    void saveSetting(key, value);
    if (key === 'theme' || key === 'themePalette' || key === 'accent' || key === 'upColor' || key === 'travelModeProjectId') applyTheme(useSettings.getState());
    if (key === 'fontSize') setFontSizePreference(value as Settings['fontSize']);
  },
}));

const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
media?.addEventListener('change', () => applyTheme(useSettings.getState()));

export function applyTheme(s: Partial<Pick<Settings, 'theme' | 'accent' | 'upColor' | 'themePalette' | 'travelModeProjectId'>>) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const dark = s.theme === 'dark' || (s.theme === 'system' && !!media?.matches);
  if (s.theme !== undefined) root.dataset.theme = dark ? 'dark' : 'light';
  if (s.accent !== undefined) root.dataset.accent = s.accent;
  if (s.upColor !== undefined) root.dataset.updown = s.upColor;
  root.dataset.palette = normalizeThemePalette(s.themePalette);
  if (s.travelModeProjectId) {
    root.dataset.mode = 'travel';
  } else {
    delete root.dataset.mode;
  }
  const metaColor = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', metaColor));
}

/**
 * 設定狀態：啟動時從 IndexedDB 載入一次，之後寫入時同步更新記憶體與 DB。
 * 主題相關設定會即時套用到 <html> 的 data-* 屬性。
 */
import { create } from 'zustand';
import { DEFAULT_SETTINGS, saveSetting, type Settings } from '@/db/repo/settings';
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
    set({ ...s, ready: true });
    applyTheme(s);
    setFontSizePreference(s.fontSize);
  },
  set: (key, value) => {
    set({ [key]: value } as Partial<SettingsState>);
    void saveSetting(key, value);
    applyTheme(useSettings.getState());
    if (key === 'fontSize') setFontSizePreference(value as Settings['fontSize']);
  },
}));

const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
media?.addEventListener('change', () => applyTheme(useSettings.getState()));

export function applyTheme(s: Pick<Settings, 'theme' | 'accent' | 'upColor' | 'themePalette'>) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const dark = s.theme === 'dark' || (s.theme === 'system' && !!media?.matches);
  const palette = s.themePalette || 'default';
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.accent = s.accent;
  root.dataset.updown = s.upColor;
  root.dataset.palette = palette;
  // 狀態列／瀏覽器 UI 顏色（配合全域風格主題）
  const metaColor = dark
    ? (palette === 'slate' ? '#0b0f14' : palette === 'forest' ? '#0b120e' : palette === 'ocean' ? '#090d16' : palette === 'oat' ? '#14110f' : '#000000')
    : (palette === 'slate' ? '#eef2f6' : palette === 'forest' ? '#f1f5f2' : palette === 'ocean' ? '#f0f3f8' : palette === 'oat' ? '#f7f4ee' : '#F2F2F7');
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', metaColor));
}

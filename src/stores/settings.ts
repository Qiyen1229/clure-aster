/**
 * 設定狀態：啟動時從 IndexedDB 載入一次，之後寫入時同步更新記憶體與 DB。
 * 主題相關設定會即時套用到 <html> 的 data-* 屬性。
 */
import { create } from 'zustand';
import { DEFAULT_SETTINGS, saveSetting, type Settings } from '@/db/repo/settings';

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
  },
  set: (key, value) => {
    set({ [key]: value } as Partial<SettingsState>);
    void saveSetting(key, value);
    applyTheme(useSettings.getState());
  },
}));

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
media?.addEventListener('change', () => applyTheme(useSettings.getState()));

export function applyTheme(s: Pick<Settings, 'theme' | 'accent' | 'upColor'>) {
  const root = document.documentElement;
  const dark = s.theme === 'dark' || (s.theme === 'system' && !!media?.matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.accent = s.accent;
  root.dataset.updown = s.upColor;
  // 狀態列／瀏覽器 UI 顏色
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#000000' : '#F2F2F7'));
}

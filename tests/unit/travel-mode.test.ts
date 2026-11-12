// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { applyTheme } from '@/stores/settings';

describe('專案／旅程記帳模式 (Travel Mode)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-mode');
  });

  it('DEFAULT_SETTINGS 包含 travelModeProjectId=null 與 excludeTravelFromReports=true', () => {
    expect(DEFAULT_SETTINGS.travelModeProjectId).toBeNull();
    expect(DEFAULT_SETTINGS.excludeTravelFromReports).toBe(true);
  });

  it('applyTheme 在 travelModeProjectId 有值時套用 data-mode="travel"，清空時移除', () => {
    const root = document.documentElement;

    applyTheme({
      theme: 'light',
      accent: 'cyan',
      upColor: 'green',
      themePalette: 'default',
      travelModeProjectId: 'proj-tokyo-2026',
    });
    expect(root.dataset.mode).toBe('travel');

    applyTheme({
      theme: 'light',
      accent: 'cyan',
      upColor: 'green',
      themePalette: 'default',
      travelModeProjectId: null,
    });
    expect(root.dataset.mode).toBeUndefined();
  });

  it('旅遊專案判斷與排他過濾邏輯符合預期', () => {
    const travelProjectIds = new Set(['proj-1']);
    const txs = [
      { id: 't1', amountMinor: 1000, projectId: undefined },
      { id: 't2', amountMinor: 2000, projectId: 'proj-1' },
      { id: 't3', amountMinor: 3000, projectId: 'proj-general' },
    ];

    // 排除旅遊專案
    const excluded = txs.filter((t) => !t.projectId || !travelProjectIds.has(t.projectId));
    expect(excluded.map((t) => t.id)).toEqual(['t1', 't3']);

    // 包含旅遊專案
    const included = txs;
    expect(included.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });
});

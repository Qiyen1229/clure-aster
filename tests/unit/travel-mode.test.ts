// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { monthGrid } from '@/domain/period';
import { trimTrailingOutMonthRow } from '@/features/home/Calendar';
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

  it('trimTrailingOutMonthRow 移除純屬下個月的最後一列，保留含當月日期的列', () => {
    // 2026 年 11 月（週日為首）：11/1 是週日、11/30 是週一，第 6 列全是 12 月 → 應裁切為 35 格
    const nov2026 = trimTrailingOutMonthRow(monthGrid(2026, 10, 0));
    expect(nov2026).toHaveLength(35);
    expect(nov2026.some((c) => c.key === '2026-11-30' && c.inMonth)).toBe(true);

    // 2026 年 8 月（週日為首）：8/1 是週六、8/31 是週一，第 6 列含 8/30, 8/31 → 應保留 42 格
    const aug2026 = trimTrailingOutMonthRow(monthGrid(2026, 7, 0));
    expect(aug2026).toHaveLength(42);
    expect(aug2026.slice(35).some((c) => c.inMonth)).toBe(true);
  });
});

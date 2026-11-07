import { afterEach, describe, expect, it, vi } from 'vitest';
import { openShortcutImport, shortcutIcloudUrl, SHORTCUTS } from '@/services/inbox';

describe('加入捷徑：直接開 iCloud 分享連結', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('六個捷徑都有各自不同的 iCloud 連結（32 位小寫十六進位）', () => {
    const ids = SHORTCUTS.map((s) => s.icloud);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
  it('「加入」＝開 https://www.icloud.com/shortcuts/<id>（不是 shortcuts://import-shortcut?url=，那個會顯示「檔案的格式不正確」）', () => {
    const loc = { href: '' };
    vi.stubGlobal('location', loc);
    openShortcutImport(SHORTCUTS[1]);
    expect(loc.href).toBe(shortcutIcloudUrl(SHORTCUTS[1]));
    expect(loc.href.startsWith('https://www.icloud.com/shortcuts/')).toBe(true);
    expect(loc.href).not.toContain('shortcuts://');
  });
});

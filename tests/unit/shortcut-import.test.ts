import { afterEach, describe, expect, it, vi } from 'vitest';
import { openShortcutImport, shortcutIcloudUrl, shortcutImportUrl, SHORTCUTS } from '@/services/inbox';

describe('加入捷徑：用 iCloud 分享連結直接切到「捷徑」App', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('六個捷徑都有各自不同的 iCloud 連結（32 位小寫十六進位）', () => {
    const ids = SHORTCUTS.map((s) => s.icloud);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(shortcutIcloudUrl(SHORTCUTS[0])).toBe(`https://www.icloud.com/shortcuts/${SHORTCUTS[0].icloud}`);
  });
  it('「加入」＝切到 shortcuts://import-shortcut?url=<iCloud 連結>（自架網址會顯示「URL 無效」，不能用）', () => {
    const loc = { href: '', origin: 'https://aster.example.com', protocol: 'https:' };
    vi.stubGlobal('location', loc);
    openShortcutImport(SHORTCUTS[1]);
    expect(loc.href).toBe(shortcutImportUrl(SHORTCUTS[1]));
    expect(decodeURIComponent(loc.href.split('url=')[1])).toBe(shortcutIcloudUrl(SHORTCUTS[1]));
    expect(loc.href).not.toContain('aster.example.com');
  });
});

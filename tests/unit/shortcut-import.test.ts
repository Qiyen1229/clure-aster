import { afterEach, describe, expect, it, vi } from 'vitest';
import { openShortcutImport, shortcutIcloudUrl, SHORTCUTS } from '@/services/inbox';

describe('加入捷徑：直接開 iCloud 分享連結', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('兩個捷徑都有各自不同的 iCloud 連結（32 位小寫十六進位）', () => {
    const ids = SHORTCUTS.map((s) => s.icloud);
    expect(new Set(ids).size).toBe(2);
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

describe('已連結的裝置名稱', () => {
  const ua = { iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15', android: 'Mozilla/5.0 (Linux; Android 15; SM-S938B Build/AP3A) AppleWebKit/537.36', mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
  it('iPhone 依螢幕尺寸顯示（iOS 不提供確切型號）；其他裝置顯示類別', async () => {
    const { deviceLabel } = await import('@/services/inbox');
    expect(deviceLabel({ userAgent: ua.iphone }, { width: 440, height: 956 })).toBe('iPhone 6.9 吋');
    expect(deviceLabel({ userAgent: ua.iphone }, { width: 956, height: 440 })).toBe('iPhone 6.9 吋'); // 橫放也一樣
    expect(deviceLabel({ userAgent: ua.iphone }, { width: 999, height: 999 })).toBe('iPhone');
    expect(deviceLabel({ userAgent: ua.android }, { width: 412, height: 915 })).toBe('Android（SM-S938B）');
    expect(deviceLabel({ userAgent: ua.mac }, { width: 1440, height: 900 })).toBe('Mac');
  });
});

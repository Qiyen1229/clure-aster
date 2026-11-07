import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkShortcutFiles, openShortcutImport, shortcutImportUrl, SHORTCUTS } from '@/services/inbox';

const resp = (init: { status?: number; type?: string; ct?: string }) => ({ status: init.status ?? 200, ok: (init.status ?? 200) < 300, type: init.type ?? 'basic', headers: new Headers({ 'content-type': init.ct ?? 'application/octet-stream' }) });

describe('加入捷徑：切到「捷徑」App', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('HTTPS：切到 shortcuts://import-shortcut，帶檔案網址與名稱；HTTP（本機測試）：改下載檔案', () => {
    const loc = { origin: 'https://aster.example.com', protocol: 'https:', href: '' };
    vi.stubGlobal('location', loc);
    openShortcutImport(SHORTCUTS[0]);
    expect(loc.href).toBe(shortcutImportUrl(SHORTCUTS[0]));
    expect(loc.href).toContain(encodeURIComponent('https://aster.example.com/shortcuts/aster-applepay.shortcut'));
    const a: Record<string, unknown> = { click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('document', { createElement: () => a, body: { appendChild: vi.fn() } });
    vi.stubGlobal('location', { origin: 'http://localhost', protocol: 'http:', href: '' });
    openShortcutImport(SHORTCUTS[0]);
    expect(a.click).toHaveBeenCalledOnce();
    expect(a.target).toBe('_blank');
  });
  it('檢查「捷徑」App 抓不抓得到檔案：正常→沒問題；轉址到登入頁／403→blocked；回傳網頁→missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp({})));
    expect((await checkShortcutFiles()).reason).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => resp({ type: 'opaqueredirect', status: 0 })));
    expect((await checkShortcutFiles()).reason).toBe('blocked');
    vi.stubGlobal('fetch', vi.fn(async () => resp({ status: 403, ct: 'text/html' })));
    expect((await checkShortcutFiles()).reason).toBe('blocked');
    vi.stubGlobal('fetch', vi.fn(async () => resp({ ct: 'text/html' })));
    const r = await checkShortcutFiles();
    expect(r.reason).toBe('missing');
    expect(r.names.length).toBe(SHORTCUTS.length);
  });
});

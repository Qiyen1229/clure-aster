import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkShortcutFiles, openShortcutImport, shortcutFileUrl, SHORTCUTS } from '@/services/inbox';

describe('捷徑匯入（不能用 shortcuts://import-shortcut?url=，自架網址會顯示「提供的捷徑 URL 無效」）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('伺服器回傳網頁（檔案不存在或被登入保護擋住）→ 回報有問題的捷徑；回傳檔案就沒問題', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })));
    expect((await checkShortcutFiles()).length).toBe(SHORTCUTS.length);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-type': 'application/vnd.apple.shortcut' } })));
    expect(await checkShortcutFiles()).toEqual([]);
  });
  it('「加入」＝下載捷徑檔（target=_blank、檔名帶中文名稱），不使用 shortcuts:// 網址', () => {
    const a: Record<string, unknown> = { click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('document', { createElement: () => a, body: { appendChild: vi.fn() } });
    openShortcutImport(SHORTCUTS[0]);
    expect(a.click).toHaveBeenCalledOnce();
    expect(a.href).toBe(shortcutFileUrl(SHORTCUTS[0]));
    expect(a.download).toBe(`${SHORTCUTS[0].name}.shortcut`);
    expect(a.target).toBe('_blank');
    expect(String(a.href)).not.toContain('shortcuts://');
  });
});

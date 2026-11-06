import { afterEach, describe, expect, it, vi } from 'vitest';
import { openShortcutImport, prefetchShortcuts, SHORTCUTS } from '@/services/inbox';

const file = () => new Response(new Uint8Array(2000), { headers: { 'content-type': 'application/octet-stream' } });

describe('捷徑匯入（不能用 shortcuts://import-shortcut?url=，自架網址會顯示「提供的捷徑 URL 無效」）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('伺服器回傳網頁（檔案不存在或被登入保護擋住）→ 回報有問題的捷徑', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })));
    expect((await prefetchShortcuts()).length).toBe(SHORTCUTS.length);
  });
  it('抓得到檔案 → 沒有問題；按「加入」用分享選單送出檔案，不使用網址匯入', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => file()));
    expect(await prefetchShortcuts()).toEqual([]);
    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { share, canShare: () => true });
    const loc = { href: '' };
    vi.stubGlobal('location', loc);
    expect(await openShortcutImport(SHORTCUTS[0])).toBe('shared');
    expect(share).toHaveBeenCalledOnce();
    expect((share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0].name).toBe(`${SHORTCUTS[0].name}.shortcut`);
    expect(loc.href).not.toContain('shortcuts://');
  });
  it('關掉分享選單 → cancelled（不當成已加入）', async () => {
    vi.stubGlobal('navigator', { share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }, canShare: () => true });
    expect(await openShortcutImport(SHORTCUTS[0])).toBe('cancelled');
  });
});

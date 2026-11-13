// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setUnauthorizedHandler } from '@/services/api';

describe('API 權杖刷新與容錯處理', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    document.cookie = 'csrf_token=test-csrf; path=/';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(() => {});
  });

  it('刷新權杖遇到斷網（fetch 拋錯）時，不呼叫 onUnauthorized 並拋出 ApiError(0)', async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '未登入' }), { status: 401 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(api('/auth/me')).rejects.toMatchObject({ status: 0 });
    expect(onUnauth).not.toHaveBeenCalled();
  });

  it('刷新權杖遇到伺服器 502/503 時，不呼叫 onUnauthorized 並拋出 ApiError(0)', async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '未登入' }), { status: 401 }))
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));

    await expect(api('/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauth).not.toHaveBeenCalled();
  });

  it('刷新權杖真正回傳 401 時，呼叫 onUnauthorized 登出', async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '未登入' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '登入已過期' }), { status: 401 }));

    await expect(api('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(onUnauth).toHaveBeenCalledTimes(1);
  });

  it('刷新權杖成功（200）時自動重試原請求並回傳結果', async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '未登入' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, username: 'alice' }), { status: 200 }));

    const res = await api<{ id: number; username: string }>('/auth/me');
    expect(res.username).toBe('alice');
    expect(onUnauth).not.toHaveBeenCalled();
  });
});

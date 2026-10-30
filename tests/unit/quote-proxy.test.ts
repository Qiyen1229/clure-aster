import { describe, expect, it, vi } from 'vitest';
import { handle, ALLOWED_HOSTS } from '../../proxy/src/core';

describe('Quote Proxy Security', () => {
  it('blocks unallowed host with 403', async () => {
    const req = new Request('http://localhost/fetch?url=https://evil.internal.corp/secret');
    const res = await handle(req, {});
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('host not allowed');
  });

  it('blocks non-https protocol with 403', async () => {
    const req = new Request('http://localhost/fetch?url=http://mis.twse.com.tw/stock/data.jsp');
    const res = await handle(req, {});
    expect(res.status).toBe(403);
  });

  it('blocks SSRF open redirect to private or unauthorized IP', async () => {
    // 模擬第三方 API 跳轉至內網或未授權 IP
    const originalFetch = globalThis.fetch;
    const mockRes = new Response(JSON.stringify({ secret: 'meta' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(mockRes, 'url', { value: 'http://169.254.169.254/latest/meta-data/' });
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockRes);

    try {
      const req = new Request(`http://localhost/fetch?url=https://${ALLOWED_HOSTS[0]}/test`);
      const res = await handle(req, {});
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('redirect to unallowed host');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('allows safe redirect to whitelisted allowed host', async () => {
    const originalFetch = globalThis.fetch;
    const mockRes = new Response(JSON.stringify({ msg: 'success' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(mockRes, 'url', { value: `https://${ALLOWED_HOSTS[1]}/redirected-path` });
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockRes);

    try {
      const req = new Request(`http://localhost/fetch?url=https://${ALLOWED_HOSTS[0]}/test`);
      const res = await handle(req, {});
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ msg: 'success' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { handle, ALLOWED_HOSTS, resolveClientIp } from '../../proxy/src/core';

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

  describe('T14: 信任代理 IP 解析防偽造', () => {
    it('非信任外部來源帶偽造 x-real-ip 或 x-forwarded-for 時採信真實 socket IP', () => {
      const publicSocketIp = '203.0.113.195';

      // 偽造 x-real-ip
      const ip1 = resolveClientIp(publicSocketIp, { 'x-real-ip': '1.1.1.1' });
      expect(ip1).toBe(publicSocketIp);

      // 偽造 x-forwarded-for
      const ip2 = resolveClientIp(publicSocketIp, { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' });
      expect(ip2).toBe(publicSocketIp);
    });

    it('來自本機 loopback 或內部私有網段信任代理時正確提取轉發 IP', () => {
      // 來自 127.0.0.1
      expect(resolveClientIp('127.0.0.1', { 'x-real-ip': '203.0.113.50' })).toBe('203.0.113.50');
      // 來自 Docker 網橋 172.18.0.2
      expect(resolveClientIp('172.18.0.2', { 'x-forwarded-for': '198.51.100.22, 172.18.0.2' })).toBe('198.51.100.22');
      // 來自 IPv6 loopback
      expect(resolveClientIp('::1', { 'x-real-ip': '198.51.100.33' })).toBe('198.51.100.33');
    });

    it('外部攻擊者輪換偽造 x-real-ip 仍以真實 socket IP 計入 rate limit', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );

      try {
        const publicIp = '198.51.100.99';
        // 發送超過 120 次請求，每次 header 帶不同的偽造 x-real-ip
        let blocked = false;
        for (let i = 0; i < 125; i++) {
          const fakeIp = `1.2.3.${i}`;
          // 經 resolveClientIp 解析出真實 IP
          const effectiveIp = resolveClientIp(publicIp, { 'x-real-ip': fakeIp });
          const req = new Request(`http://localhost/fetch?url=https://${ALLOWED_HOSTS[0]}/test`, {
            headers: { 'x-real-ip': fakeIp },
          });
          const res = await handle(req, {}, { ip: effectiveIp });
          if (res.status === 429) {
            blocked = true;
            break;
          }
        }
        expect(blocked).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

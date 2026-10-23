/**
 * Cloudflare Workers 入口。部署：見 proxy/README.md
 *   npx wrangler deploy
 * 前端「設定 → 股票資料源 → 代理網址」填入 https://<name>.<account>.workers.dev
 */
import { handle, type CacheLike, type ProxyEnv } from './src/core';

declare const caches: { default: Cache };

const edgeCache: CacheLike = {
  async get(key) {
    return (await caches.default.match(key)) ?? undefined;
  },
  async put(key, res, ttl) {
    const r = new Response(res.body, res);
    r.headers.set('cache-control', `public, max-age=${ttl}`);
    await caches.default.put(key, r);
  },
};

export default {
  async fetch(req: Request, env: ProxyEnv): Promise<Response> {
    return handle(req, env, { ip: req.headers.get('cf-connecting-ip') ?? 'anon', cache: edgeCache });
  },
};

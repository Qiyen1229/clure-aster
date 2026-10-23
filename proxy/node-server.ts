/**
 * Node 入口（NAS Docker 的 quote-proxy 容器使用，Node 20+ 內建 fetch）。
 *   PORT=9123 ACCESS_TOKEN=xxx node --experimental-strip-types node-server.ts
 * nginx 會把同源的 /proxy/* 轉到這裡，前端代理網址維持預設 /proxy 即可。
 */
import { createServer } from 'node:http';
import { handle, memoryCache } from './src/core.ts';

const port = Number(process.env.PORT ?? 9123);
const env = { ACCESS_TOKEN: process.env.ACCESS_TOKEN || undefined, ALLOW_ORIGIN: process.env.ALLOW_ORIGIN || undefined };
const cache = memoryCache(800);

createServer(async (req, res) => {
  try {
    const url = `http://localhost${req.url ?? '/'}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const ip = (req.headers['x-real-ip'] as string) ?? (req.headers['x-forwarded-for'] as string)?.split(',')[0] ?? req.socket.remoteAddress ?? 'anon';
    const r = await handle(new Request(url, { method: req.method, headers }), env, { ip, cache, basePath: '/proxy' });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
}).listen(port, () => console.log(`clure-quote-proxy listening on :${port}`));

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import pkg from './package.json';
import type { Connect, Plugin } from 'vite';
import { handle, memoryCache } from './proxy/src/core';

/** 開發／預覽伺服器內建報價代理：/proxy/* → proxy/src/core.ts（與 NAS、Cloudflare 版本同一份程式） */
function clureProxy(): Plugin {
  const cache = memoryCache();
  const mw: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith('/proxy')) return next();
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const r = await handle(new Request(`http://localhost${req.url}`, { method: req.method, headers }), {
        ACCESS_TOKEN: process.env.PROXY_ACCESS_TOKEN || undefined,
      }, { ip: req.socket.remoteAddress ?? 'local', cache, basePath: '/proxy' });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  };
  return {
    name: 'clure-quote-proxy',
    configureServer: (server) => { server.middlewares.use(mw); },
    configurePreviewServer: (server) => { server.middlewares.use(mw); },
  };
}

// 預覽與開發固定使用 9122 埠（見 docs/DESIGN.md A10）
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // /api 轉給本機 FastAPI（cd server && .venv/bin/uvicorn app.main:app --port 8000）
  server: { port: 9122, strictPort: true, proxy: { '/api': { target: process.env.CLURE_API_URL ?? 'http://127.0.0.1:8000', changeOrigin: false } } },
  preview: { port: 9122, strictPort: true, proxy: { '/api': { target: process.env.CLURE_API_URL ?? 'http://127.0.0.1:8000', changeOrigin: false } } },
  build: { target: 'es2020', sourcemap: false },
  plugins: [
    clureProxy(),
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'], globIgnores: ['splash/**'] },
      devOptions: { enabled: false },
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        id: '/',
        name: 'Clure 記帳',
        short_name: 'Clure',
        description: '資料只存在你裝置上的個人記帳與投資組合 App',
        lang: 'zh-Hant-TW',
        start_url: '/?source=pwa',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#000000',
        background_color: '#000000',
        categories: ['finance', 'productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: '快速記帳', short_name: '記帳', url: '/add?source=shortcut', icons: [{ src: '/icons/shortcut-add.png', sizes: '96x96' }] },
          { name: '查看投資', short_name: '投資', url: '/accounts?tab=invest&source=shortcut', icons: [{ src: '/icons/shortcut-invest.png', sizes: '96x96' }] },
        ],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as any);

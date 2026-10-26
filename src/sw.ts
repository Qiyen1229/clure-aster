/// <reference lib="webworker" />
/**
 * Service Worker（Workbox injectManifest）
 * - 預快取所有建置產物 → 完整離線可用
 * - SPA 導覽一律回傳快取的 index.html
 * - 不自動 skipWaiting：由前端顯示「有新版本，點擊更新」，使用者同意後才切換，避免資料寫到一半被換版
 * - 匯率等外部 API 採 NetworkFirst，離線時使用最後一次結果
 * - 背景推播（push）：顯示伺服器排定的提醒；點擊通知開啟對應頁面（notificationclick）
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/proxy\//, /^\/api\//] }));

registerRoute(
  ({ url }) => url.hostname === 'open.er-api.com' || url.pathname.includes('/currency-api'),
  new NetworkFirst({ cacheName: 'fx', networkTimeoutSeconds: 6, plugins: [new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 7 * 86400 })] }),
);

registerRoute(
  ({ request }) => request.destination === 'image' && request.url.startsWith(self.location.origin),
  new StaleWhileRevalidate({ cacheName: 'images', plugins: [new ExpirationPlugin({ maxEntries: 60 })] }),
);

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('push', (event) => {
  let msg: { title?: string; body?: string; url?: string; tag?: string } = {};
  try { msg = event.data?.json() ?? {}; } catch { msg = { body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(msg.title || 'Clure 記帳', {
    body: msg.body ?? '', icon: '/icons/icon-192.png', badge: '/icons/favicon-32.png', tag: msg.tag, data: { url: msg.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) { void (c as WindowClient).navigate(url); return (c as WindowClient).focus(); }
      return self.clients.openWindow(url);
    }),
  );
});

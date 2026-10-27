/**
 * 手動檢查新版本（設定 → 關於 → 版本）。
 * 平常由 Service Worker 每 30 分鐘、回到前景時自動檢查；這裡讓使用者部署後不用等，立刻更新。
 * 找到新版就切換到新的 Service Worker 並重新整理；資料都在 IndexedDB／伺服器，不會遺失。
 */
export type UpdateResult = 'reloading' | 'latest' | 'unsupported';

function waitInstalled(sw: ServiceWorker, ms = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    if (sw.state === 'installed' || sw.state === 'activated') return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' || sw.state === 'activated') { clearTimeout(t); resolve(true); }
      if (sw.state === 'redundant') { clearTimeout(t); resolve(false); }
    });
  });
}

function activateAndReload(sw: ServiceWorker) {
  let done = false;
  const reload = () => { if (!done) { done = true; location.reload(); } };
  navigator.serviceWorker.addEventListener('controllerchange', reload);
  sw.postMessage({ type: 'SKIP_WAITING' });
  setTimeout(reload, 3000); // 保險：controllerchange 沒觸發也會重新整理
}

/** 連不到伺服器時會丟出錯誤 */
export async function checkForUpdate(): Promise<UpdateResult> {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return 'unsupported';
  await reg.update();
  const next = reg.waiting ?? reg.installing;
  if (!next || !(await waitInstalled(next))) return 'latest';
  activateAndReload(reg.waiting ?? next);
  return 'reloading';
}

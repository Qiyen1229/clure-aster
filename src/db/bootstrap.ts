/**
 * App 啟動時的資料初始化：建立預設分類、要求持久化儲存、背景任務（匯率…）。
 * 其餘「開啟 App 時補算」任務見 services/startup.ts（首屏後動態載入）。
 */
import { db } from './schema';
import { markBaseline } from './sync-tracking';
import { buildDefaultCategories } from './seed/categories';
import { loadSettings } from './repo/settings';
import { ensureOtherSubcategories } from './repo/categories';

export async function bootstrap() {
  await db.open();
  // 預設分類：全新資料庫才建立全部；之後只補上程式需要的系統分類（避免使用者刪掉的預設分類又跑回來，
  // 也避免新裝置的預設值經同步覆蓋其他裝置的修改）
  await db.transaction('rw', db.categories, async (tx) => {
    markBaseline(tx);
    const existing = new Set(await db.categories.toCollection().primaryKeys());
    const defaults = buildDefaultCategories();
    const missing = existing.size === 0 ? defaults : defaults.filter((c) => c.id.startsWith('sys-') && !existing.has(c.id));
    if (missing.length) await db.categories.bulkAdd(missing);
  });
  // 每個主分類都要有「其他」子分類
  await ensureOtherSubcategories();
  // 要求瀏覽器將資料標記為「持久化」，降低 iOS／Safari 在空間不足時清除資料的機率
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* 不支援則略過 */ }
  const settings = await loadSettings();
  return settings;
}

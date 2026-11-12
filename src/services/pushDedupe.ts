/**
 * 推播去重：Service Worker push 與本機提醒（Reminders）互相去重，確保同一個提醒只響一次。
 */
import type { Reminder } from '@/db/types';

export const TAG_KIND_MAP: Record<string, Reminder['kind']> = {
  daily: 'daily_log',
  daily_log: 'daily_log',
  card: 'card_due',
  card_due: 'card_due',
  budget: 'budget',
  sub: 'subscription',
  subscription: 'subscription',
  price: 'price_alert',
  price_alert: 'price_alert',
  backup: 'backup',
  sync: 'sync',
  insight: 'insight',
  invoice: 'invoice',
  inbox: 'inbox',
};

export function tagToKind(tag: string): Reminder['kind'] {
  const prefix = tag.split(':')[0] || '';
  return TAG_KIND_MAP[prefix] || 'daily_log';
}

export async function getReminderDbNames(preferredDb?: string): Promise<string[]> {
  if (preferredDb && preferredDb.trim()) return [preferredDb.trim()];
  if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
    try {
      const dbs = await indexedDB.databases();
      const userDbs = dbs
        .map((d) => d.name)
        .filter((n): n is string => typeof n === 'string' && /^clure-u\d+$/.test(n));
      if (userDbs.length > 0) return userDbs;
    } catch {
      // 忽略 indexedDB.databases 查詢失敗
    }
  }
  return ['clure'];
}

async function checkSingleDb(tag: string, dbName: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(dbName);
      req.onerror = () => resolve(false);
      req.onsuccess = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('reminders')) {
          d.close();
          return resolve(false);
        }
        const tx = d.transaction('reminders', 'readonly');
        const store = tx.objectStore('reminders');
        const getReq = store.get(tag);
        getReq.onsuccess = () => {
          d.close();
          resolve(!!getReq.result);
        };
        getReq.onerror = () => {
          d.close();
          resolve(false);
        };
      };
    } catch {
      resolve(false);
    }
  });
}

export async function hasLocalReminder(tag: string, dbName?: string): Promise<boolean> {
  if (!tag || typeof indexedDB === 'undefined') return false;
  const dbNames = await getReminderDbNames(dbName);
  for (const name of dbNames) {
    if (await checkSingleDb(tag, name)) return true;
  }
  return false;
}

export async function recordLocalReminder(
  item: { tag: string; title: string; body: string; url: string },
  dbName?: string,
): Promise<void> {
  if (!item.tag || typeof indexedDB === 'undefined') return;
  const dbNames = await getReminderDbNames(dbName);
  const targetDb = dbNames[0] || 'clure';

  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(targetDb);
      req.onerror = () => resolve();
      req.onsuccess = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('reminders')) {
          d.close();
          return resolve();
        }
        const tx = d.transaction('reminders', 'readwrite');
        const store = tx.objectStore('reminders');
        store.put({
          id: item.tag,
          kind: tagToKind(item.tag),
          refId: item.url,
          dueAt: Date.now(),
          done: 0,
          notifiedAt: Date.now(),
          title: item.title,
          body: item.body,
        });
        tx.oncomplete = () => {
          d.close();
          resolve();
        };
        tx.onerror = () => {
          d.close();
          resolve();
        };
      };
    } catch {
      resolve();
    }
  });
}

export async function processPushNotification(
  msg: { title?: string; body?: string; url?: string; tag?: string; db?: string },
  showNotification: (title: string, options: any) => Promise<any> | any,
  dbName?: string,
): Promise<boolean> {
  const targetDb = dbName || msg.db;
  const tag = msg.tag;
  if (tag) {
    const exists = await hasLocalReminder(tag, targetDb);
    if (exists) return false;
  }
  const title = msg.title || 'Aster 記帳';
  const body = msg.body ?? '';
  const url = msg.url || '/';
  await showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    tag,
    data: { url },
  });
  if (tag) {
    await recordLocalReminder({ tag, title, body, url }, targetDb);
  }
  return true;
}

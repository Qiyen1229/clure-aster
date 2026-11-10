/**
 * 推播去重：Service Worker push 與本機提醒（Reminders）互相去重，確保同一個提醒只響一次。
 */

export async function hasLocalReminder(tag: string, dbName = 'clure'): Promise<boolean> {
  if (!tag || typeof indexedDB === 'undefined') return false;
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

export async function recordLocalReminder(
  item: { tag: string; title: string; body: string; url: string },
  dbName = 'clure',
): Promise<void> {
  if (!item.tag || typeof indexedDB === 'undefined') return;
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(dbName);
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
          kind: (item.tag.split(':')[0] || 'daily_log') as any,
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
  msg: { title?: string; body?: string; url?: string; tag?: string },
  showNotification: (title: string, options: any) => Promise<any> | any,
  dbName = 'clure',
): Promise<boolean> {
  const tag = msg.tag;
  if (tag) {
    const exists = await hasLocalReminder(tag, dbName);
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
    await recordLocalReminder({ tag, title, body, url }, dbName);
  }
  return true;
}

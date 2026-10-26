/**
 * 端對端加密同步（選用）。
 *
 * - 加密密碼只在裝置上：PBKDF2-SHA256（310,000 次）＋伺服器保存的隨機鹽 → AES-256-GCM 金鑰
 * - 金鑰以「不可匯出」的 CryptoKey 存在這台裝置的 IndexedDB（meta，不同步、不進備份）
 * - 上傳的每筆資料改為 { $enc: 1, iv, ct }；伺服器（含管理員）只看得到資料表名稱、資料 id、修改時間
 * - 伺服器保存「以金鑰加密的固定字串」，新裝置輸入密碼後用來確認密碼正確
 * - 忘記加密密碼無法復原伺服器上的資料（但各裝置本機仍有完整明文，可停用後重新上傳）
 */
import { db } from '@/db/schema';

export const E2EE_ITERATIONS = 310_000;
const CHECK_TEXT = 'clure-e2ee-v1';
const META_KEY = 'e2ee.key';
const META_VERSION = 'e2ee.version';
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface E2EEConfig { enabled: boolean; salt: string; iterations: number; check: string; version: number }
export interface Encrypted { $enc: 1; iv: string; ct: string }

export class E2EELockedError extends Error {
  constructor() { super('這個帳號已啟用端對端加密，請到「設定 → 帳號 → 端對端加密」輸入加密密碼'); }
}

const b64 = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function deriveKey(passphrase: string, saltB64: string, iterations: number, extractable = false): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations }, base, { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<Encrypted> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { $enc: 1, iv: b64(iv), ct: b64(ct) };
}

export async function decryptJson<T = unknown>(key: CryptoKey, e: Encrypted): Promise<T> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, key, unb64(e.ct));
  return JSON.parse(dec.decode(pt)) as T;
}

export const isEncrypted = (p: unknown): p is Encrypted => !!p && typeof p === 'object' && (p as { $enc?: unknown }).$enc === 1;

// ───── 這台裝置的金鑰 ─────

let memKey: CryptoKey | null | undefined;
/** 記憶體中的金鑰屬於哪個資料庫（切換帳號時自動失效） */
let memDb = '';

export async function localKey(): Promise<CryptoKey | null> {
  if (memDb !== db.name) { memKey = undefined; memDb = db.name; }
  if (memKey !== undefined) return memKey;
  const row = await db.meta.get(META_KEY).catch(() => undefined);
  memKey = (row?.value as CryptoKey | undefined) ?? null;
  return memKey;
}

async function storeKey(key: CryptoKey | null, version: number): Promise<void> {
  memKey = key;
  memDb = db.name;
  if (key) {
    // 有些瀏覽器（或測試環境）無法把 CryptoKey 存進 IndexedDB：退回只放記憶體（下次開 App 需重新輸入）
    try { await db.meta.put({ key: META_KEY, value: key }); } catch { /* 只在記憶體 */ }
    await db.meta.put({ key: META_VERSION, value: version });
  } else {
    await db.meta.bulkDelete([META_KEY, META_VERSION]);
  }
}

/** 依伺服器設定調整本機狀態；回傳目前可用的金鑰（未啟用時為 null） */
export async function reconcile(cfg: E2EEConfig | null | undefined): Promise<CryptoKey | null> {
  const key = await localKey();
  if (!cfg?.enabled) {
    if (key) await storeKey(null, 0);
    return null;
  }
  if (!key) throw new E2EELockedError();
  const ver = (await db.meta.get(META_VERSION))?.value as number | undefined;
  if (ver !== cfg.version) {
    // 其他裝置更換了密碼：用目前的金鑰驗證，不符就要求重新輸入
    try {
      if ((await decryptJson<string>(key, JSON.parse(cfg.check))) !== CHECK_TEXT) throw new Error();
      await db.meta.put({ key: META_VERSION, value: cfg.version });
    } catch {
      await storeKey(null, 0);
      throw new E2EELockedError();
    }
  }
  return key;
}

/** 新裝置：輸入密碼解鎖 */
export async function unlock(cfg: E2EEConfig, passphrase: string): Promise<boolean> {
  const key = await deriveKey(passphrase, cfg.salt, cfg.iterations);
  try {
    if ((await decryptJson<string>(key, JSON.parse(cfg.check))) !== CHECK_TEXT) return false;
  } catch { return false; }
  await storeKey(key, cfg.version);
  return true;
}

/** 啟用或更換密碼：產生新的鹽與驗證字串；回傳要送到伺服器的設定 */
export async function createConfig(passphrase: string): Promise<{ salt: string; iterations: number; check: string; key: CryptoKey }> {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(passphrase, salt, E2EE_ITERATIONS);
  const check = JSON.stringify(await encryptJson(key, CHECK_TEXT));
  return { salt, iterations: E2EE_ITERATIONS, check, key };
}

export async function activate(key: CryptoKey | null, version: number): Promise<void> {
  await storeKey(key, version);
}

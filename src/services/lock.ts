/**
 * App 鎖：
 * - PIN：PBKDF2-SHA256（210,000 次）+ 隨機 salt，只存雜湊
 * - 生物辨識：WebAuthn 平台驗證器（Face ID／Touch ID）。註冊時保存公鑰，解鎖時在本機用 WebCrypto 驗證簽章，
 *   並檢查 challenge、origin、User Verified 旗標 —— 不需要伺服器。
 * 注意：App 鎖保護的是「畫面」，資料本身仍以明文存在瀏覽器儲存空間（見已知限制）。
 */
import { create } from 'zustand';
import { useSettings } from '@/stores/settings';

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf: ArrayBuffer | Uint8Array) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function hashPin(pin: string, saltB64: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations }, key, 256);
  return b64(bits);
}

export async function setPin(pin: string) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const s = useSettings.getState();
  const pinHash = await hashPin(pin, salt, s.lock.iterations);
  s.set('lock', { ...s.lock, enabled: true, salt, pinHash });
}

export async function verifyPin(pin: string): Promise<boolean> {
  const { lock } = useSettings.getState();
  if (!lock.pinHash) return false;
  const h = await hashPin(pin, lock.salt, lock.iterations);
  // 定長比較
  if (h.length !== lock.pinHash.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ lock.pinHash.charCodeAt(i);
  return diff === 0;
}

export function disableLock() {
  const s = useSettings.getState();
  s.set('lock', { ...s.lock, enabled: false, pinHash: '', salt: '', webauthn: null });
}

// ───── WebAuthn ─────

export async function biometricAvailable(): Promise<boolean> {
  try {
    return !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { return false; }
}

export async function registerBiometric(): Promise<void> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Aster 記帳', id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'aster', displayName: 'Aster 使用者' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000,
      attestation: 'none',
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('未建立憑證');
  const resp = cred.response as AuthenticatorAttestationResponse;
  const pk = resp.getPublicKey?.();
  const alg = resp.getPublicKeyAlgorithm?.() ?? -7;
  if (!pk) throw new Error('此瀏覽器不支援取得公鑰，無法啟用生物辨識');
  const s = useSettings.getState();
  s.set('lock', { ...s.lock, webauthn: { credId: b64(cred.rawId), publicKey: b64(pk), alg } });
}

/** DER 編碼的 ECDSA 簽章 → WebCrypto 需要的 r||s（各 32 bytes） */
export function derToRaw(der: Uint8Array): Uint8Array {
  let i = 2;
  if (der[1] & 0x80) i += der[1] & 0x7f;
  const read = () => {
    if (der[i++] !== 0x02) throw new Error('bad DER');
    const len = der[i++];
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = read();
  const s = read();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

export async function verifyBiometric(): Promise<boolean> {
  const { lock } = useSettings.getState();
  if (!lock.webauthn) return false;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge, rpId: location.hostname, userVerification: 'required', timeout: 60000,
      allowCredentials: [{ type: 'public-key', id: unb64(lock.webauthn.credId) }],
    },
  })) as PublicKeyCredential | null;
  if (!cred) return false;
  const r = cred.response as AuthenticatorAssertionResponse;
  const clientData = JSON.parse(new TextDecoder().decode(r.clientDataJSON));
  if (clientData.type !== 'webauthn.get' || clientData.challenge !== b64url(challenge) || clientData.origin !== location.origin) return false;
  const auth = new Uint8Array(r.authenticatorData);
  const flags = auth[32];
  if (!(flags & 0x01) || !(flags & 0x04)) return false; // UP + UV
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', r.clientDataJSON));
  const data = new Uint8Array(auth.length + hash.length);
  data.set(auth, 0);
  data.set(hash, auth.length);
  const spki = unb64(lock.webauthn.publicKey);
  if (lock.webauthn.alg === -257) {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, r.signature, data as BufferSource);
  }
  const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(new Uint8Array(r.signature)) as BufferSource, data as BufferSource);
}

// ───── 鎖定狀態 ─────

interface LockState { locked: boolean; hiddenAt: number; lock: () => void; unlock: () => void }
export const useLock = create<LockState>((set) => ({
  locked: false,
  hiddenAt: 0,
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
}));

/** 背景超過 autoLockSec 秒回來時上鎖 */
export function installAutoLock() {
  const onVis = () => {
    const { lock } = useSettings.getState();
    if (!lock.enabled) return;
    if (document.visibilityState === 'hidden') useLock.setState({ hiddenAt: Date.now() });
    else {
      const { hiddenAt } = useLock.getState();
      if (hiddenAt && Date.now() - hiddenAt >= lock.autoLockSec * 1000) useLock.getState().lock();
    }
  };
  document.addEventListener('visibilitychange', onVis);
  return () => document.removeEventListener('visibilitychange', onVis);
}

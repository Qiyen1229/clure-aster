/**
 * 再確認身分：輸入密碼（帳號有開雙因素驗證時，伺服器會再要驗證碼），用在刪除帳號、忘記 App 鎖 PIN。
 * `call` 收到 `{ password, totp? }` 去打對應的 API；成功回傳 true，取消或失敗回傳 false（失敗會跳提示）。
 */
import { ApiError } from '@/services/api';
import { askInput, useUI } from '@/stores/ui';

export interface IdentityBody { password: string; totp?: string }

export async function confirmIdentity(call: (body: IdentityBody) => Promise<unknown>, opts: { title: string; message?: string; confirmText: string; danger?: boolean }): Promise<boolean> {
  const password = await askInput({ title: opts.title, message: opts.message, placeholder: '你的登入密碼', secret: true, required: true, maxLength: 128, confirmText: opts.confirmText, danger: opts.danger });
  if (!password) return false;
  let totp: string | undefined;
  for (let i = 0; i < 3; i++) {
    try { await call({ password, ...(totp ? { totp } : {}) }); return true; } catch (e) {
      if (e instanceof ApiError && e.totpRequired) {
        const code = await askInput({ title: '輸入雙因素驗證碼', message: totp ? e.message : '打開驗證 App，輸入目前的 6 位數（或一組備援碼）。', required: true, maxLength: 20, inputMode: 'numeric', confirmText: opts.confirmText, danger: opts.danger });
        if (!code) return false;
        totp = code;
        continue;
      }
      useUI.getState().showSnack({ text: e instanceof ApiError ? e.message : '發生錯誤，請稍後再試', duration: 5000 });
      return false;
    }
  }
  return false;
}

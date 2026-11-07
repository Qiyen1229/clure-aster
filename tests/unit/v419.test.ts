import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { ApiError } from '@/services/api';
import { confirmIdentity } from '@/services/identity';
import { askInput, useUI } from '@/stores/ui';

beforeEach(() => { useUI.setState({ input: null, confirm: null }); });

describe('預設收支顏色：支出紅、收入綠（可在設定改成台股習慣）', () => {
  it("預設 upColor 是 'green'（收入／獲利綠、支出／虧損紅）", () => {
    expect(DEFAULT_SETTINGS.upColor).toBe('green');
  });
});

describe('自製輸入視窗（取代 window.prompt）', () => {
  it('回傳輸入的文字；取消回傳 null；新的視窗會把前一個當取消', async () => {
    const p = askInput({ title: '名字', required: true });
    expect(useUI.getState().input?.title).toBe('名字');
    useUI.getState().closeInput('肯德基');
    expect(await p).toBe('肯德基');
    expect(useUI.getState().input).toBeNull();
    const a = askInput({ title: 'A' });
    const b = askInput({ title: 'B' });
    expect(await a).toBeNull();
    useUI.getState().closeInput(null);
    expect(await b).toBeNull();
  });
});

describe('再確認身分（刪除帳號、忘記 PIN）', () => {
  const answer = async (v: string | null) => { await vi.waitFor(() => expect(useUI.getState().input).toBeTruthy()); useUI.getState().closeInput(v); };

  it('密碼對就成功；取消回傳 false 且不呼叫 API', async () => {
    const call = vi.fn(async () => undefined);
    const p = confirmIdentity(call, { title: '確認', confirmText: '刪除' });
    await answer('pw123456');
    expect(await p).toBe(true);
    expect(call).toHaveBeenCalledWith({ password: 'pw123456' });
    const call2 = vi.fn();
    const p2 = confirmIdentity(call2, { title: '確認', confirmText: '刪除' });
    await answer(null);
    expect(await p2).toBe(false);
    expect(call2).not.toHaveBeenCalled();
  });
  it('帳號有開雙因素驗證：伺服器要求驗證碼時再問一次，帶著驗證碼重送', async () => {
    const call = vi.fn(async (b: { password: string; totp?: string }) => { if (!b.totp) throw new ApiError(401, '請輸入雙因素驗證碼', true); });
    const p = confirmIdentity(call, { title: '確認', confirmText: '刪除' });
    await answer('pw123456');
    await vi.waitFor(() => expect(useUI.getState().input?.title).toContain('驗證碼'));
    useUI.getState().closeInput('123456');
    expect(await p).toBe(true);
    expect(call).toHaveBeenLastCalledWith({ password: 'pw123456', totp: '123456' });
  });
  it('密碼錯：顯示伺服器的訊息並回傳 false', async () => {
    const call = vi.fn(async () => { throw new ApiError(400, '密碼不正確'); });
    const p = confirmIdentity(call, { title: '確認', confirmText: '刪除' });
    await answer('wrong');
    expect(await p).toBe(false);
    expect(useUI.getState().snack?.text).toBe('密碼不正確');
  });
});

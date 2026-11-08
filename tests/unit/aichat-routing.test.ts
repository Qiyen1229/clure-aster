/**
 * v4.1.11：AI 開啟時的對話分流——打招呼／閒聊走「閒聊」（不扣額度），問到自己的錢才走「問 AI」（扣 1 點）。
 * 以前這類句子都會得到「我沒有聽出金額」。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chat = vi.fn(async () => ({ answer: '嗨！', followups: [] as string[] }));
const ask = vi.fn(async () => ({ value: { answer: '你的錢包有 1 萬', followups: [] as string[] }, cached: false, quota: undefined }));
vi.mock('@/services/ai', async (orig) => ({
  ...(await orig<typeof import('@/services/ai')>()),
  aiEnabledLocally: () => true,
  aiDataEnabled: () => true,
  aiChatTalk: (...a: unknown[]) => (chat as (...x: unknown[]) => unknown)(...a),
  aiAsk: (...a: unknown[]) => (ask as (...x: unknown[]) => unknown)(...a),
}));

import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { respond } from '@/features/home/AiChat';

describe('對話框分流（AI 開啟）', () => {
  beforeEach(async () => {
    chat.mockClear(); ask.mockClear();
    await db.delete(); await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    await addAccount({ name: '中國信託', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 1_000_000, includeInNetWorth: true, isLiability: false });
  });

  it.each(['你好', '嗨', '謝謝你', '你可以做什麼'])('★ 一般對話走閒聊，不送帳務資料、不扣額度：%s', async (t) => {
    const r = await respond(t);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
    expect(r).toMatchObject({ kind: 'text', text: '嗨！' });
  });

  it.each(['分析我的錢包', '我的中國信託有多少錢', '中國信託', '幫我檢討一下我的財務'])('★ 問到自己的錢才走「問 AI」：%s', async (t) => {
    const r = await respond(t);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
    expect(r).toMatchObject({ kind: 'text' });
  });

  it('記帳仍然優先，不會被當成閒聊', async () => {
    const r = await respond('午餐 120');
    expect(r.kind).toBe('entries');
    expect(chat).not.toHaveBeenCalled();
  });
});

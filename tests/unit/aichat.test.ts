/**
 * v2.0.1：首頁對話框的分流——記帳、查帳走規則（免費），規則做不到才說明如何開啟 AI
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction } from '@/db/repo/ledger';
import { respond } from '@/features/home/AiChat';
import { todayKey } from '@/domain/period';

describe('對話框 respond（AI 關閉時）', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    const a = await addAccount({ name: '錢包', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 1_000_000, includeInNetWorth: true, isLiability: false });
    await addTransaction({ type: 'expense', accountId: a.id, categoryId: 'exp-food-lunch', amountMinor: 15000, currency: 'TWD', date: todayKey(), ts: Date.now(), note: '便當' });
  });

  it('★ 一句話記帳：回傳草稿，不會直接入帳', async () => {
    const r = await respond('午餐 120');
    expect(r).toMatchObject({ role: 'ai', kind: 'entries', via: 'rule' });
    if (r.kind === 'entries') expect(r.drafts).toMatchObject([{ kind: 'expense', amount: 120 }]);
    expect(await db.transactions.count()).toBe(1); // 還沒記帳
  });

  it.each(['昨天午餐 120', '上週五晚餐 350 刷玉山卡', '今天早餐 60', '10/25 咖啡 85'])('★ 帶日期詞的記帳也是記帳，不是查帳：%s', async (t) => {
    const r = await respond(t);
    expect(r.kind).toBe('entries');
  });

  it.each(['今天吃飯花多少', '這週咖啡喝了幾次', '今年最大一筆', '上個月收入'])('統計問法交給查帳：%s', async (t) => {
    const r = await respond(t);
    expect(r.kind).toBe('text');
  });

  it('一次多筆', async () => {
    const r = await respond('早餐 60 午餐 120');
    expect(r.kind === 'entries' && r.drafts.length).toBe(2);
  });

  it('★ 查帳問題：規則直接回答，並附上查看帳目的連結', async () => {
    const r = await respond('今天吃飯花多少');
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.text).toMatch(/150/);
      expect(r.link?.to).toMatch(/^\/search\?q=/);
    }
  });

  it('規則看不懂的問題：說明如何開啟 AI（不呼叫任何 API）', async () => {
    const r = await respond('怎麼存錢比較快？');
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.text).toMatch(/AI/);
      expect(r.link?.to).toBe('/settings/ai');
    }
  });

  it('沒有金額的閒聊：給記帳與查帳的用法提示', async () => {
    const r = await respond('你好');
    expect(r.kind).toBe('text');
    if (r.kind === 'text') expect(r.text).toMatch(/午餐 120/);
  });
});

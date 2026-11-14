/**
 * v4.1.39 自動記帳白名單：
 * - matchesWhitelist：名稱出現在商家或訊息裡就命中（不分大小寫、全半形正規化）
 * - judgeNotice：白名單優先放行（包含原本會被留審的 LINE 聊天）
 * - processInboxOnStartup：沒開全域自動入帳時，白名單發送者的通知仍直接記帳；其餘照舊留收件匣
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiState = vi.hoisted(() => ({ items: [] as unknown[], acked: [] as number[] }));
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    api: vi.fn(async (path: string, opts?: { body?: unknown }) => {
      if (path === '/inbox/items') return apiState.items;
      if (path === '/inbox/items/ack') {
        const ids = (opts?.body as { ids: number[] }).ids;
        apiState.acked.push(...ids);
        return { ids };
      }
      throw new Error(`未預期的 API 呼叫：${path}`);
    }),
  };
});

import { db } from '@/db/schema';
import { addAccount } from '@/db/repo/accounts';
import { judgeNotice, matchesWhitelist, processInboxOnStartup, type InboxRaw } from '@/services/inbox';
import { useSettings } from '@/stores/settings';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';

const n = (card: string, text: string, merchant = '') => ({ source: 'notify', card, text, merchant }) as Parameters<typeof judgeNotice>[0];

describe('白名單比對', () => {
  it('名稱出現在商家或訊息裡就命中；不分大小寫、全半形', () => {
    expect(matchesWhitelist({ merchant: '玉山銀行', text: '消費 120 元' }, ['玉山銀行'])).toBe(true);
    expect(matchesWhitelist({ merchant: '', text: '【LINE Pay】付款成功' }, ['line pay'])).toBe(true);
    expect(matchesWhitelist({ merchant: '', text: 'ＬＩＮＥ Ｐａｙ 付款' }, ['LINE Pay'])).toBe(true);
    expect(matchesWhitelist({ merchant: '全家', text: '消費 85 元' }, ['玉山'])).toBe(false);
  });
  it('空名單、空白項目不算命中', () => {
    expect(matchesWhitelist({ merchant: '玉山', text: '' }, [])).toBe(false);
    expect(matchesWhitelist({ merchant: '玉山', text: '' }, ['  '])).toBe(false);
  });
});

describe('通知把關：白名單優先', () => {
  it('LINE 聊天有金額：沒白名單留審；白名單命中就放行', () => {
    const chat = n('LINE', '晚餐 500 你先幫我付', '小明');
    expect(judgeNotice(chat, true).trust).toBe('review');
    expect(judgeNotice(chat, true, ['小明']).trust).toBe('ok');
    expect(judgeNotice(chat, true, ['別人']).trust).toBe('review');
  });
  it('白名單命中時，連沒金額的 LINE 聊天也不會被丟掉', () => {
    expect(judgeNotice(n('LINE', '今天好冷喔', '小明'), false).trust).toBe('drop');
    expect(judgeNotice(n('LINE', '今天好冷喔', '小明'), false, ['小明']).trust).toBe('ok');
  });
  it('官方通知與非 LINE 來源不受白名單影響', () => {
    expect(judgeNotice(n('LINE', '【LINE Pay】您已於 全家 消費 NT$85，付款成功'), true).trust).toBe('ok');
    expect(judgeNotice(n('國泰世華', '刷卡 120 元'), true).trust).toBe('ok');
  });
});

describe('啟動自動入帳：白名單發送者不用開全域自動入帳', () => {
  let bank = '';
  const raw = (id: number, card: string, text: string, merchant = ''): InboxRaw =>
    ({ id, source: 'notify', text, amount: '', merchant, card, occurred: '', created_at: new Date().toISOString() });
  const setInbox = (autoBook: boolean, whitelist: string[]) => {
    const s = useSettings.getState();
    s.set('inbox', { ...s.inbox, autoBook, whitelist, defaultAccountId: bank });
  };

  beforeEach(async () => {
    await db.delete(); await db.open();
    apiState.items = []; apiState.acked = [];
    useSettings.setState({ ...DEFAULT_SETTINGS, baseCurrency: 'TWD', monthStartDay: 1 } as never);
    await db.categories.bulkAdd([{ id: 'exp-other', name: '其他', kind: 'expense', parentId: '', icon: '', color: '', sort: 0, archived: 0, createdAt: 1, updatedAt: 1 }] as never);
    bank = (await addAccount({ name: '台新', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 1_000_000, includeInNetWorth: true, isLiability: false })).id;
    apiState.items = [
      raw(1, '玉山銀行', '【玉山銀行】您於 全家 消費 120 元', '全家'),
      raw(2, '國泰世華', '【國泰世華】於 7-ELEVEN 消費 85 元', '7-ELEVEN'),
      raw(3, 'LINE', '晚餐 500 你先幫我付', '小明'),
      raw(4, '玉山銀行', '今天好冷喔'),
    ];
  });

  it('沒開自動入帳＋白名單「玉山銀行」：只有它的消費通知直接記帳', async () => {
    setInbox(false, ['玉山銀行']);
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 1, pending: 3 });
    const txs = await db.transactions.toArray();
    expect(txs).toHaveLength(1);
    expect(txs[0].amountMinor).toBe(12_000);
    expect((await db.accounts.get(bank))!.balanceMinor).toBe(1_000_000 - 12_000);
    expect(apiState.acked).toEqual([1]);
  });

  it('白名單加上 LINE 好友「小明」：聊天裡的金額也直接記（不再留審）', async () => {
    setInbox(false, ['玉山銀行', '小明']);
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 2, pending: 2 });
    expect((await db.transactions.toArray()).map((t) => t.amountMinor).sort((a, b) => a - b)).toEqual([12_000, 50_000]);
  });

  it('沒開自動入帳、也沒白名單：全部留收件匣', async () => {
    setInbox(false, []);
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 0, pending: 4 });
    expect(await db.transactions.count()).toBe(0);
  });

  it('開了全域自動入帳：照舊全部記（LINE 聊天仍留審）', async () => {
    setInbox(true, []);
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 2, pending: 2 });
  });

  it('白名單命中但看不懂金額：還是留收件匣', async () => {
    setInbox(false, ['玉山銀行']);
    apiState.items = [raw(4, '玉山銀行', '今天好冷喔')];
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 0, pending: 1 });
  });
});
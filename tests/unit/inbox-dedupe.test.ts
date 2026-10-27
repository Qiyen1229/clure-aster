import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { markDuplicates, type InboxEntry, type InboxRaw } from '@/services/inbox';
import type { ResolvedDraft } from '@/services/quickentry';

const raw = (id: number, source: InboxRaw['source'], created: string, over: Partial<InboxRaw> = {}): InboxRaw =>
  ({ id, source, text: '', amount: '', merchant: '', card: '', occurred: '', created_at: created, ...over });
const draft = (over: Partial<ResolvedDraft> = {}): ResolvedDraft => ({
  kind: 'expense', amount: 120, currency: 'TWD', date: '2026-10-27', dateGiven: true, accountId: 'a1', note: '全聯', raw: '',
  categoryId: 'exp-food', tagIds: [], categorySource: 'default', accountSource: 'default', ...over,
});
const entry = (item: InboxRaw, d: ResolvedDraft = draft()): InboxEntry => ({ item, drafts: [d] });

describe('收件匣標出重複', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.accounts.clear();
    await db.accounts.add({ id: 'a1', name: '玉山', type: 'bank', currency: 'TWD' } as never);
  });

  it('Apple Pay 與簡訊在 15 分鐘內通知同一筆 → 後者確定重複', async () => {
    const a = entry(raw(1, 'applepay', '2026-10-27 04:00:00', { merchant: '全聯' }));
    const b = entry(raw(2, 'sms', '2026-10-27 04:02:00', { merchant: '全聯福利中心' }));
    await markDuplicates([a, b], '2026-10-27');
    expect(a.dup).toBeUndefined();
    expect(b.dup).toMatchObject({ from: 'inbox', inboxId: 1, level: 'strong', certain: true });
  });

  it('同來源、隔很久的相同金額 → 不是確定重複', async () => {
    const a = entry(raw(1, 'applepay', '2026-10-27 01:00:00'));
    const b = entry(raw(2, 'applepay', '2026-10-27 09:00:00'));
    await markDuplicates([a, b], '2026-10-27');
    expect(b.dup?.certain).toBe(false);
  });

  it('帳本已有同金額同店名 → 很可能重複，不是確定', async () => {
    await db.transactions.add({
      id: 't1', type: 'expense', accountId: 'a1', categoryId: 'exp-food', amountMinor: 12000, currency: 'TWD', date: '2026-10-27',
      note: '全聯福利中心', merchant: '全聯福利中心', invoiceNo: 'AB12345678', tagIds: [], attachmentIds: [],
    } as never);
    const e = entry(raw(3, 'applepay', '2026-10-27 04:00:00', { merchant: '全聯' }));
    await markDuplicates([e], '2026-10-27');
    expect(e.dup).toMatchObject({ from: 'ledger', txId: 't1', level: 'strong' });
    expect(e.dup?.certain).toBeUndefined();
  });

  it('已刪除與系統分類（借貸）的帳目不算', async () => {
    await db.transactions.bulkAdd([
      { id: 'd1', type: 'expense', accountId: 'a1', categoryId: 'exp-food', amountMinor: 12000, currency: 'TWD', date: '2026-10-27', note: '全聯', deletedAt: 1, tagIds: [], attachmentIds: [] },
      { id: 'd2', type: 'expense', accountId: 'a1', categoryId: 'sys-debt-out', amountMinor: 12000, currency: 'TWD', date: '2026-10-27', note: '全聯', tagIds: [], attachmentIds: [] },
    ] as never);
    const e = entry(raw(4, 'applepay', '2026-10-27 04:00:00'));
    await markDuplicates([e], '2026-10-27');
    expect(e.dup).toBeUndefined();
  });

  it('收入與支出不互相比對；多筆（Siri）不比對', async () => {
    await db.transactions.add({ id: 'i1', type: 'income', accountId: 'a1', categoryId: 'inc-refund', amountMinor: 12000, currency: 'TWD', date: '2026-10-27', note: '全聯', tagIds: [], attachmentIds: [] } as never);
    const e = entry(raw(5, 'applepay', '2026-10-27 04:00:00'));
    const multi: InboxEntry = { item: raw(6, 'siri', '2026-10-27 04:00:00'), drafts: [draft(), draft({ amount: 60 })] };
    await markDuplicates([e, multi], '2026-10-27');
    expect(e.dup).toBeUndefined();
    expect(multi.dup).toBeUndefined();
  });
});

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { findPinned, listPinned, MAX_PINNED, pinKey, pinTransaction, touchPinned, unpin, updatePinnedAmount } from '@/db/repo/pinned';
import { mergeSuggestions, pinnedSuggestions, rankNoteSuggestions, type NoteSuggestion } from '@/domain/notesuggest';
import { recentNoteSuggestions } from '@/services/autocat';

const snap = (over: Partial<Parameters<typeof pinTransaction>[0]> = {}) => ({
  type: 'expense' as const, note: '肯德基 晚餐', amountMinor: 16000, currency: 'TWD', categoryId: 'exp-food-dinner', accountId: 'a1', tagIds: [], ...over,
});

beforeEach(async () => { await db.templates.clear(); await db.transactions.clear(); });

describe('釘選常用記帳（存在 templates 表，會同步與備份）', () => {
  it('釘選、取消、更新金額；同一個備註（不分大小寫與前後空白）再釘選＝更新而不是新增', async () => {
    const a = await pinTransaction(snap());
    expect(a.created).toBe(true);
    const b = await pinTransaction(snap({ note: '  肯德基 晚餐 ', amountMinor: 17000 }));
    expect(b).toEqual({ id: a.id, created: false });
    expect((await listPinned())).toHaveLength(1);
    expect((await listPinned())[0].payload.amountMinor).toBe(17000);
    await updatePinnedAmount(a.id, 18000);
    expect((await db.templates.get(a.id))?.payload.amountMinor).toBe(18000);
    await updatePinnedAmount(a.id, 0); // 無效金額不改
    expect((await db.templates.get(a.id))?.payload.amountMinor).toBe(18000);
    await unpin(a.id);
    expect(await listPinned()).toEqual([]);
  });
  it('支出與收入、不同幣別的同名備註是不同的釘選；沒備註或沒金額不能釘', async () => {
    await pinTransaction(snap());
    await pinTransaction(snap({ type: 'income', categoryId: 'inc-x' }));
    await pinTransaction(snap({ currency: 'USD' }));
    expect(await listPinned()).toHaveLength(3);
    expect(findPinned(await listPinned(), { type: 'expense', note: '肯德基 晚餐', currency: 'USD' })).toBeTruthy();
    expect(pinKey('expense', ' A ', 'TWD')).toBe(pinKey('expense', 'a', 'TWD'));
    await expect(pinTransaction(snap({ note: '   ' }))).rejects.toThrow('備註');
    await expect(pinTransaction(snap({ amountMinor: 0 }))).rejects.toThrow('金額');
  });
  it(`最多釘選 ${MAX_PINNED} 個；用得越多排越前面`, async () => {
    for (let i = 0; i < MAX_PINNED; i++) await pinTransaction(snap({ note: `店${i}` }));
    await expect(pinTransaction(snap({ note: '多一個' }))).rejects.toThrow(String(MAX_PINNED));
    await pinTransaction(snap({ note: '店3', amountMinor: 999 })); // 已存在的可以更新
    const id = (await listPinned()).find((t) => t.name === '店7')!.id;
    await touchPinned(id); await touchPinned(id);
    expect((await listPinned())[0].id).toBe(id);
  });
  it('舊版（v4.0.7 以前）的手動範本直接變成釘選項目；資料不完整的不列出', async () => {
    const now = Date.now();
    await db.templates.bulkAdd([
      { id: 't1', name: '早餐', sort: 0, useCount: 5, createdAt: now, updatedAt: now, payload: { type: 'expense', accountId: 'a1', categoryId: 'c1', amountMinor: 8000, currency: 'TWD', tagIds: [] } },
      { id: 't2', name: '壞的', sort: 1, useCount: 0, createdAt: now, updatedAt: now, payload: { type: 'expense' } },
    ]);
    const list = await listPinned();
    expect(list.map((t) => t.id)).toEqual(['t1']);
  });
});

describe('建議清單：釘選排最前面', () => {
  const auto = (note: string): NoteSuggestion => ({ note, amountMinor: 100, currency: 'TWD', categoryId: 'c', accountId: 'a', tagIds: [], count: 3, lastTs: 1 });
  const pin = (id: string, note: string, over = {}) => ({ id, note, type: 'expense', currency: 'TWD', amountMinor: 16000, categoryId: 'c', accountId: 'a', tagIds: [] as string[], useCount: 0, updatedAt: 1, ...over });

  it('沒打字：全部釘選（常用的優先）；打字：備註包含，開頭符合的優先；類型與幣別要對', () => {
    const pins = [pin('1', '肯德基 晚餐'), pin('2', '麥當勞', { useCount: 4 }), pin('3', '晚餐聚會'), pin('4', '薪水', { type: 'income' }), pin('5', 'KFC', { currency: 'USD' })];
    expect(pinnedSuggestions(pins, '', { type: 'expense', currency: 'TWD' }).map((x) => x.pinnedId)).toEqual(['2', '1', '3']);
    expect(pinnedSuggestions(pins, '晚餐', { type: 'expense', currency: 'TWD' }).map((x) => x.pinnedId)).toEqual(['3', '1']);
    expect(pinnedSuggestions(pins, '肯', { type: 'expense', currency: 'TWD' }).map((x) => x.pinnedId)).toEqual(['1']);
  });
  it('合併：釘選最前面（最多 8 個），自動推薦同名的不重複、補到最多 4 個', () => {
    const pinned = pinnedSuggestions([pin('1', '肯德基 晚餐'), pin('2', '麥當勞')], '', { type: 'expense', currency: 'TWD' });
    const out = mergeSuggestions(pinned, [auto('麥當勞'), auto('全家'), auto('星巴克'), auto('捷運'), auto('早餐'), auto('午餐')]);
    expect(out.map((x) => x.note)).toEqual(['肯德基 晚餐', '麥當勞', '全家', '星巴克', '捷運', '早餐']);
    expect(out.filter((x) => x.pinnedId)).toHaveLength(2);
  });
  it('整合：超過 90 天沒記、也不在最近 800 筆的項目，釘選後仍然出現在空白畫面', async () => {
    await pinTransaction(snap());
    const old = Date.now() - 400 * 86_400_000;
    const txs = [{ id: 'x', type: 'expense', note: '肯德基 晚餐', amountMinor: 15000, currency: 'TWD', categoryId: 'c', accountId: 'a', tagIds: [], ts: old, deletedAt: null }] as never;
    expect(rankNoteSuggestions(txs, '', { type: 'expense', currency: 'TWD' })).toEqual([]); // 沒釘選：空白畫面看不到
    const out = await recentNoteSuggestions('', 'expense', 'TWD');
    expect(out[0]).toMatchObject({ note: '肯德基 晚餐', amountMinor: 16000 });
    expect(out[0].pinnedId).toBeTruthy();
  });
});

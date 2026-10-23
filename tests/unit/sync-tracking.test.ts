/**
 * 同步變更追蹤：各種寫入方式都會進入待上傳佇列；遠端套用的不會
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { markRemote, outboxId } from '@/db/sync-tracking';

const ids = async () => (await db.sync_outbox.toArray()).map((e) => e.id).sort();

describe('同步變更追蹤', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('add / put / update / modify / delete / clear 都會記錄', async () => {
    const now = Date.now();
    await db.tags.add({ id: 't1', name: 'A', color: '#000', sort: 0, createdAt: now, updatedAt: now });
    await db.tags.bulkPut([{ id: 't2', name: 'B', color: '#000', sort: 1, createdAt: now, updatedAt: now }]);
    expect(await ids()).toEqual([outboxId('tags', 't1'), outboxId('tags', 't2')]);
    await db.sync_outbox.clear();
    await db.tags.update('t1', { name: 'A2' });
    expect(await ids()).toEqual([outboxId('tags', 't1')]);
    await db.sync_outbox.clear();
    await db.tags.where('sort').above(0).modify({ color: '#fff' });
    expect(await ids()).toEqual([outboxId('tags', 't2')]);
    await db.sync_outbox.clear();
    await db.tags.delete('t1');
    expect(await ids()).toEqual([outboxId('tags', 't1')]);
    await db.sync_outbox.clear();
    await db.tags.clear();
    expect(await ids()).toEqual([outboxId('tags', 't2')]);
  });

  it('複合主鍵與設定；裝置專屬設定不記錄；非同步表不記錄', async () => {
    await db.exchange_rates.put({ base: 'USD', quote: 'TWD', rateDec: '32', updatedAt: 1 } as never);
    await db.settings.put({ key: 'baseCurrency', value: 'JPY' });
    await db.settings.put({ key: 'lock', value: {} });
    await db.meta.put({ key: 'x', value: 1 });
    expect(await ids()).toEqual([outboxId('exchange_rates', ['USD', 'TWD']), outboxId('settings', 'baseCurrency')].sort());
  });

  it('巢狀交易一起記錄；遠端標記的交易不記錄', async () => {
    await db.transaction('rw', db.tags, db.people, async () => {
      await db.tags.put({ id: 'n1', name: 'N', color: '#000', sort: 0, createdAt: 0, updatedAt: 0 });
      await db.transaction('rw', db.people, async () => { await db.people.put({ id: 'p1', name: '小明', createdAt: 0, updatedAt: 0 }); });
    });
    expect((await ids()).length).toBe(2);
    await db.sync_outbox.clear();
    await db.transaction('rw', db.tags, async (tx) => {
      markRemote(tx);
      await db.tags.put({ id: 'r1', name: 'R', color: '#000', sort: 0, createdAt: 0, updatedAt: 0 });
      await db.tags.delete('n1');
    });
    expect(await ids()).toEqual([]);
    expect(await db.tags.get('r1')).toBeTruthy();
  });
});

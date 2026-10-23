import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import * as schema from '@/db/schema';
import { ClureDB } from '@/db/schema';

describe('每位使用者獨立的本機資料庫', () => {
  it('切換使用者時資料互不可見，並標記擁有者', async () => {
    await schema.openUserDatabase(1);
    await schema.db.tags.add({ id: 't1', name: 'A 的標籤', color: '#fff', sort: 0, createdAt: 0, updatedAt: 0 });
    expect(schema.db.name).toBe('clure-u1');
    expect((await schema.db.meta.get('ownerUserId'))?.value).toBe('1');
    await schema.openUserDatabase(2);
    expect(schema.db.name).toBe('clure-u2');
    expect(await schema.db.tags.count()).toBe(0);
    await schema.openUserDatabase(1);
    expect(await schema.db.tags.count()).toBe(1);
  });

  it('帳號系統啟用前的資料可歸屬到目前帳號，之後舊庫被刪除', async () => {
    const legacy = new ClureDB('clure');
    await legacy.open();
    await legacy.tags.add({ id: 'old', name: '舊資料', color: '#000', sort: 0, createdAt: 0, updatedAt: 0 });
    await legacy.meta.put({ key: 'fxUpdatedAt', value: 123 });
    legacy.close();
    await schema.openUserDatabase(7);
    expect(await schema.legacyDataCount()).toBe(0); // 只算帳目與帳戶
    const l2 = new ClureDB('clure');
    await l2.open();
    await l2.accounts.add({ id: 'a', name: '錢包', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 0, balanceMinor: 0, includeInNetWorth: true, isLiability: false, sort: 0, archived: 0, createdAt: 0, updatedAt: 0 });
    l2.close();
    expect(await schema.legacyDataCount()).toBe(1);
    await schema.adoptLegacyData();
    expect(await schema.db.tags.get('old')).toBeTruthy();
    expect(await schema.db.accounts.get('a')).toBeTruthy();
    expect((await schema.db.meta.get('ownerUserId'))?.value).toBe('7'); // 擁有者未被覆蓋
    expect(await Dexie.exists('clure')).toBe(false);
  });
});

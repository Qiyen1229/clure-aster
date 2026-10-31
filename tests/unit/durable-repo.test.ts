import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addDurable, addUse, reopenDurable, sellDurable } from '@/db/repo/durables';

describe('耐用物品存取', () => {
  let accId = '';
  beforeEach(async () => {
    await db.delete(); await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    accId = (await addAccount({ name: 'A', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false })).id;
  });
  const phone = () => addDurable({ name: 'iPhone', icon: '📱', purchaseDate: '2025-08-01', costMinor: 36900_00, currency: 'TWD', lifeYears: 3 });

  it('新增：預設在用；沒開「追蹤使用次數」就不存使用次數', async () => {
    const d = await addDurable({ name: ' 耳機 ', icon: '🎧', purchaseDate: '2026-01-01', costMinor: 5000_00, currency: 'TWD', uses: 5 });
    expect(d.status).toBe('active');
    expect(d.name).toBe('耳機');
    expect(d.uses).toBeUndefined();
  });
  it('追蹤使用次數：累加', async () => {
    const d = await addDurable({ name: '單車', icon: '🚲', purchaseDate: '2026-01-01', costMinor: 20000_00, currency: 'TWD', trackUses: true, uses: 0 });
    await addUse(d.id); await addUse(d.id, 2);
    expect((await db.durables.get(d.id))!.uses).toBe(3);
    await addUse(d.id, -10);
    expect((await db.durables.get(d.id))!.uses).toBe(0);
  });
  it('賣掉：記下殘值與處置日，同時記一筆收入並讓帳戶餘額增加', async () => {
    const d = await phone();
    const { durable, saleTx } = await sellDurable({ id: d.id, endDate: '2027-06-30', saleMinor: 12000_00, income: { accountId: accId, categoryId: 'inc-other_inc' } });
    expect(durable.status).toBe('sold');
    expect(saleTx?.type).toBe('income');
    expect(saleTx?.note).toContain('iPhone');
    expect((await db.accounts.get(accId))!.balanceMinor).toBe(12000_00);
    expect((await db.durables.get(d.id))!.saleTxId).toBe(saleTx!.id);
  });
  it('淘汰（0 元）不記收入；不能重複處理；處置日不能早於購入日', async () => {
    const d = await phone();
    await expect(sellDurable({ id: d.id, endDate: '2025-07-01', saleMinor: 0 })).rejects.toThrow('早於購入日');
    const r = await sellDurable({ id: d.id, endDate: '2027-01-01', saleMinor: 0, income: { accountId: accId, categoryId: 'inc-other_inc' } });
    expect(r.durable.status).toBe('retired');
    expect(r.saleTx).toBeUndefined();
    await expect(sellDurable({ id: d.id, endDate: '2027-02-01', saleMinor: 0 })).rejects.toThrow('已經處理過');
  });
  it('反悔：復原成還在用', async () => {
    const d = await phone();
    await sellDurable({ id: d.id, endDate: '2027-06-30', saleMinor: 5000_00 });
    await reopenDurable(d.id);
    const back = (await db.durables.get(d.id))!;
    expect(back.status).toBe('active');
    expect(back.endDate).toBeUndefined();
    expect(back.saleMinor).toBeUndefined();
  });
});

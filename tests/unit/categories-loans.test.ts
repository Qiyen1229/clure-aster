/**
 * 「其他」子分類、應收／應付帳款（借出／借入）
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories, OTHER_SUB_NAME } from '@/db/seed/categories';
import { addCategory, buildTree, ensureOtherSubcategories, updateCategory } from '@/db/repo/categories';
import { addAccount } from '@/db/repo/accounts';
import { addLoan, removeLoan, settleDebt } from '@/db/repo/plan';
import { countsInStats } from '@/domain/ledger';

const bal = async (id: string) => (await db.accounts.get(id))!.balanceMinor;

describe('「其他」子分類', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    await ensureOtherSubcategories();
  });

  it('每個可選的主分類都有「其他」，且排在最後', async () => {
    const all = await db.categories.toArray();
    for (const kind of ['expense', 'income'] as const) {
      for (const { main, subs } of buildTree(all, kind)) {
        if (main.name === OTHER_SUB_NAME) { expect(subs).toHaveLength(0); continue; }
        expect(subs.at(-1)?.name, main.name).toBe(OTHER_SUB_NAME);
      }
    }
  });

  it('重複執行不會產生重複的「其他」；被封存會恢復', async () => {
    expect(await ensureOtherSubcategories()).toBe(0);
    await updateCategory('exp-food-other', { archived: 1 });
    expect(await ensureOtherSubcategories()).toBe(1);
    expect((await db.categories.get('exp-food-other'))!.archived).toBe(0);
    expect(await db.categories.where('parentId').equals('exp-food').filter((c) => c.name === OTHER_SUB_NAME).count()).toBe(1);
  });

  it('新增主分類時自動附上「其他」', async () => {
    const main = await addCategory({ kind: 'expense', parentId: '', name: '露營', icon: '⛺', color: '#30D158' });
    const subs = await db.categories.where('parentId').equals(main.id).toArray();
    expect(subs.map((c) => c.name)).toEqual([OTHER_SUB_NAME]);
  });

  it('隱藏的系統分類（借出／借入等）不出現在選擇器', async () => {
    const all = await db.categories.toArray();
    const ids = buildTree(all, 'expense').map((t) => t.main.id).concat(buildTree(all, 'income').map((t) => t.main.id));
    expect(ids).not.toContain('sys-debt-out');
    expect(ids).not.toContain('sys-debt-in');
  });
});

describe('應收／應付帳款', () => {
  let accId = '';
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    accId = (await addAccount({ name: '錢包', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 1000000, includeInNetWorth: true, isLiability: false })).id;
  });

  it('借出：帳戶扣款、建立應收，且不計入收支；收回後餘額回復且仍不計入收支', async () => {
    const { debtId, txId } = await addLoan({ direction: 'they_owe_me', personName: '小明', amountMinor: 300000, currency: 'TWD', date: '2026-10-10', ts: 1, note: '' , accountId: accId });
    expect(await bal(accId)).toBe(700000);
    const tx = (await db.transactions.get(txId!))!;
    expect(tx.categoryId).toBe('sys-debt-out');
    expect(countsInStats(tx)).toBe(false);
    expect(tx.excludeFromBudget).toBe(true);
    await settleDebt(debtId, accId);
    expect(await bal(accId)).toBe(1000000);
    const back = (await db.transactions.get((await db.debts.get(debtId))!.settleTransferId!))!;
    expect(back.categoryId).toBe('sys-debt-in');
    expect(countsInStats(back)).toBe(false);
  });

  it('借入：帳戶入帳、建立應付；還款後扣回且不計入支出', async () => {
    const { debtId } = await addLoan({ direction: 'i_owe_them', personName: '媽媽', amountMinor: 500000, currency: 'TWD', date: '2026-10-10', ts: 1, note: '周轉', accountId: accId });
    expect(await bal(accId)).toBe(1500000);
    await settleDebt(debtId, accId);
    expect(await bal(accId)).toBe(1000000);
    const repay = (await db.transactions.get((await db.debts.get(debtId))!.settleTransferId!))!;
    expect(repay.categoryId).toBe('sys-debt-out');
    expect(countsInStats(repay)).toBe(false);
  });

  it('只記欠款（不動帳戶）：餘額不變；復原會刪除欠款', async () => {
    const { debtId, txId } = await addLoan({ direction: 'they_owe_me', personName: '小華', amountMinor: 20000, currency: 'TWD', date: '2026-10-10', ts: 1, note: '' });
    expect(txId).toBeUndefined();
    expect(await bal(accId)).toBe(1000000);
    expect((await db.people.where('name').equals('小華').count())).toBe(1);
    await removeLoan(debtId);
    expect(await db.debts.get(debtId)).toBeUndefined();
  });

  it('復原借出：帳戶餘額回復', async () => {
    const { debtId } = await addLoan({ direction: 'they_owe_me', personName: '小明', amountMinor: 300000, currency: 'TWD', date: '2026-10-10', ts: 1, note: '', accountId: accId });
    await removeLoan(debtId);
    expect(await bal(accId)).toBe(1000000);
  });
});

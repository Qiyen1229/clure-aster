import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction, deleteTransactions, restoreTransactions, updateTransaction } from '@/db/repo/ledger';
import { addDurable, durableOfTx, reopenDurable, sellDurable, syncTxDurable } from '@/db/repo/durables';
import { checkPriceAlerts } from '@/db/repo/invest';
import { loadSampleData, clearSampleData } from '@/db/seed/sample';
import { runHealthCheck } from '@/services/health';

const mkAcc = () => addAccount({ name: 'A', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
const bal = async (id: string) => (await db.accounts.get(id))!.balanceMinor ?? 0;

describe('耐用品與帳目連動', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories() as never);
  });

  async function bought() {
    const a = await mkAcc();
    const tx = await addTransaction({ type: 'expense', accountId: a.id, categoryId: 'exp-shopping-daily', amountMinor: 3_600_000, currency: 'TWD', date: '2026-01-10', ts: 1, note: '手機' });
    const d = await addDurable({ name: '手機', icon: '📱', purchaseDate: '2026-01-10', costMinor: 3_600_000, currency: 'TWD', lifeYears: 3, txId: tx.id });
    return { a, tx, d };
  }

  it('刪除購入帳目 → 耐用品一併標記刪除；復原帳目 → 一起復原', async () => {
    const { tx, d } = await bought();
    await deleteTransactions([tx.id]);
    expect((await db.durables.get(d.id))?.deletedAt).toBeTruthy();
    expect(await durableOfTx(tx.id)).toBeUndefined();
    await restoreTransactions([tx.id]);
    expect((await db.durables.get(d.id))?.deletedAt).toBeFalsy();
    expect(await durableOfTx(tx.id)).toBeTruthy();
  });

  it('改回還在用 → 賣出時自動記的二手收入一併刪除，帳戶餘額回到賣出前；再賣一次只會有一筆收入', async () => {
    const { a, d } = await bought();
    const before = await bal(a.id);
    await sellDurable({ id: d.id, endDate: '2026-06-01', saleMinor: 1_000_000, income: { accountId: a.id, categoryId: 'inc-other_inc' } });
    expect(await bal(a.id)).toBe(before + 1_000_000);
    const r = await reopenDurable(d.id);
    expect(r.removedSale).toBe(true);
    expect(await bal(a.id)).toBe(before);
    expect((await db.durables.get(d.id))?.status).toBe('active');
    await sellDurable({ id: d.id, endDate: '2026-06-02', saleMinor: 900_000, income: { accountId: a.id, categoryId: 'inc-other_inc' } });
    expect(await bal(a.id)).toBe(before + 900_000);
    expect((await db.transactions.filter((t) => t.type === 'income' && !t.deletedAt).toArray()).length).toBe(1);
  });

  it('直接在帳目刪掉賣出收入 → 物品改回還在用；復原那筆收入 → 還原成已賣出', async () => {
    const { a, d } = await bought();
    const { saleTx } = await sellDurable({ id: d.id, endDate: '2026-06-01', saleMinor: 1_000_000, income: { accountId: a.id, categoryId: 'inc-other_inc' } });
    await deleteTransactions([saleTx!.id]);
    expect((await db.durables.get(d.id))?.status).toBe('active');
    await restoreTransactions([saleTx!.id]);
    const back = await db.durables.get(d.id);
    expect(back).toMatchObject({ status: 'sold', saleMinor: 1_000_000, endDate: '2026-06-01' });
  });

  it('編輯帳目：金額與日期改了，耐用品的成本與購入日跟著更新；取消標記會刪掉物品；補標記會新增', async () => {
    const { a, tx } = await bought();
    const input = { type: 'expense' as const, accountId: a.id, categoryId: 'exp-shopping-daily', currency: 'TWD', ts: 1, note: '手機' };
    const t2 = await updateTransaction(tx.id, { ...input, amountMinor: 3_000_000, date: '2026-01-20' });
    await syncTxDurable(t2, 3, { name: '手機', icon: '📱' });
    expect(await durableOfTx(tx.id)).toMatchObject({ costMinor: 3_000_000, purchaseDate: '2026-01-20', lifeYears: 3 });
    await syncTxDurable(t2, 0, { name: '手機', icon: '📱' });
    expect(await durableOfTx(tx.id)).toBeUndefined();
    await syncTxDurable(t2, 2, { name: '手機', icon: '📱' }); // 事後補標記
    expect(await durableOfTx(tx.id)).toMatchObject({ lifeYears: 2, costMinor: 3_000_000 });
    await syncTxDurable(t2, -1, { name: '', icon: '' }); // 原本沒設期限：只跟著更新成本，期限不動
    expect((await durableOfTx(tx.id))?.lifeYears).toBe(2);
  });

  it('健康檢查：購入帳目永久清除後，耐用品會被列為「找不到對應的帳目」並可解除關聯', async () => {
    const { tx, d } = await bought();
    await db.transactions.delete(tx.id);
    const issue = (await runHealthCheck()).find((i) => i.id === 'orphan_durables');
    expect(issue?.count).toBe(1);
    await issue!.fix();
    expect((await db.durables.get(d.id))?.txId).toBeUndefined();
    expect((await runHealthCheck()).some((i) => i.id === 'orphan_durables')).toBe(false);
  });

  it('範例資料：有耐用品、帶發票號碼的帳目與漲價的 Netflix；清除範例時耐用品一起清掉', async () => {
    await loadSampleData();
    expect(await db.durables.count()).toBe(2);
    expect(await db.transactions.filter((t) => !!t.invoiceNo).count()).toBeGreaterThanOrEqual(5);
    const nf = (await db.transactions.filter((t) => t.note === 'Netflix').toArray()).sort((x, y) => (x.date < y.date ? -1 : 1));
    expect(nf.length).toBeGreaterThanOrEqual(2);
    expect(nf[nf.length - 1].amountMinor).toBeGreaterThan(nf[0].amountMinor);
    await clearSampleData();
    expect(await db.durables.count()).toBe(0);
  });
});

describe('到價提醒：只在穿越時通知一次', () => {
  beforeEach(async () => { await db.delete(); await db.open(); });

  async function setup(alert: { op: '>=' | '<='; priceDec: string }) {
    await db.stocks.add({ id: 's1', market: 'TW', symbol: '2330', name: '台積電', currency: 'TWD' } as never);
    await db.watchlist.add({ id: 'w1', stockId: 's1', sort: 0, alerts: [{ ...alert, enabled: true }], createdAt: 1, updatedAt: 1 } as never);
  }
  const price = (p: string) => db.price_cache.put({ stockId: 's1', priceDec: p, changePctDec: '-1', updatedAt: Date.now() } as never);

  it('跌破 2300：跌破時通知；持續在下面不再通知；站回後再跌破才再通知', async () => {
    await setup({ op: '<=', priceDec: '2300' });
    await price('2310'); expect(await checkPriceAlerts()).toHaveLength(0);
    await price('2295'); expect(await checkPriceAlerts()).toHaveLength(1); // 跌破 → 通知
    await price('2290'); expect(await checkPriceAlerts()).toHaveLength(0); // 還在下面 → 不通知
    await price('2280'); expect(await checkPriceAlerts()).toHaveLength(0);
    await price('2305'); expect(await checkPriceAlerts()).toHaveLength(0); // 站回 → 重新武裝
    await price('2299'); expect(await checkPriceAlerts()).toHaveLength(1); // 再跌破 → 再通知
  });

  it('站上提醒同理；每次穿越的通知 id 不同（同一天重複穿越也不會被去重吃掉）', async () => {
    await setup({ op: '>=', priceDec: '1000' });
    await price('1001'); const a = await checkPriceAlerts();
    await price('999'); await checkPriceAlerts();
    await new Promise((r) => setTimeout(r, 5));
    await price('1002'); const b = await checkPriceAlerts();
    expect(a).toHaveLength(1); expect(b).toHaveLength(1);
    expect(a[0].id).not.toBe(b[0].id);
  });

  it('舊資料（只有 lastTriggeredAt、沒有 triggered）視為已觸發，不會因升級重複通知', async () => {
    await db.stocks.add({ id: 's1', market: 'TW', symbol: '2330', name: '台積電', currency: 'TWD' } as never);
    await db.watchlist.add({ id: 'w1', stockId: 's1', sort: 0, alerts: [{ op: '<=', priceDec: '2300', enabled: true, lastTriggeredAt: Date.now() - 20 * 3600_000 }], createdAt: 1, updatedAt: 1 } as never);
    await price('2250'); expect(await checkPriceAlerts()).toHaveLength(0);
  });
});

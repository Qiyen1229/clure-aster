/**
 * 耐用物品存取層：新增、修改、賣掉／淘汰（可同時記一筆二手賣出收入）、還原、累計使用次數。
 * 帳目的寫入一律走 repo/ledger（維護帳戶餘額）。
 */
import { db, uid } from '../schema';
import type { Durable, Transaction } from '../types';
import { addTransaction, deleteTransactions } from './ledger';
import { getSetting } from './settings';

const now = () => Date.now();

export type DurableInput = Pick<Durable, 'name' | 'icon' | 'purchaseDate' | 'costMinor' | 'currency'> & Partial<Pick<Durable, 'lifeYears' | 'trackUses' | 'uses' | 'note' | 'txId'>>;

export async function addDurable(input: DurableInput): Promise<Durable> {
  const row: Durable = { ...input, name: input.name.trim() || '耐用物品', id: uid(), status: 'active', createdAt: now(), updatedAt: now() };
  if (!row.trackUses) { delete row.trackUses; delete row.uses; }
  await db.durables.add(row);
  return row;
}

export async function updateDurable(id: string, patch: Partial<DurableInput>) {
  await db.durables.update(id, { ...patch, updatedAt: now() });
}

export async function deleteDurable(id: string) {
  await db.durables.delete(id);
}

/** 用了一次（只有開啟「追蹤使用次數」的物品） */
export async function addUse(id: string, n = 1) {
  const d = await db.durables.get(id);
  if (!d) return;
  await db.durables.update(id, { uses: Math.max(0, (d.uses ?? 0) + n), updatedAt: now() });
}

export interface SellInput {
  id: string;
  endDate: string;
  /** 二手賣出金額（最小單位）；淘汰或送人就是 0 */
  saleMinor: number;
  /** 要同時記一筆收入時給帳戶與分類 */
  income?: { accountId: string; categoryId: string };
}

/** 賣掉（saleMinor > 0）或淘汰（0）：結束持有、記下殘值，可同時記一筆收入並關聯回物品 */
export async function sellDurable(input: SellInput): Promise<{ durable: Durable; saleTx?: Transaction }> {
  const d = await db.durables.get(input.id);
  if (!d) throw new Error('找不到這件物品');
  if (d.status !== 'active') throw new Error('這件物品已經處理過了');
  if (input.endDate < d.purchaseDate) throw new Error('處置日不能早於購入日');
  let saleTx: Transaction | undefined;
  if (input.saleMinor > 0 && input.income) {
    saleTx = await addTransaction({
      type: 'income', accountId: input.income.accountId, categoryId: input.income.categoryId, amountMinor: input.saleMinor, currency: d.currency,
      date: input.endDate, ts: Date.now(), note: `二手賣出：${d.name}`,
    });
  }
  const patch: Partial<Durable> = {
    status: input.saleMinor > 0 ? 'sold' : 'retired', endDate: input.endDate, saleMinor: input.saleMinor > 0 ? input.saleMinor : undefined,
    saleTxId: saleTx?.id, updatedAt: now(),
  };
  await db.durables.update(d.id, patch);
  return { durable: { ...d, ...patch }, saleTx };
}

/**
 * 復原成「還在用」（賣錯、反悔）。賣出時自動記的那筆二手收入會一併刪除（可在帳目「最近刪除」復原），
 * 否則帳戶餘額會多出一筆錢，再賣一次又會再記一筆。
 */
export async function reopenDurable(id: string): Promise<{ removedSale: boolean }> {
  const d = await db.durables.get(id);
  if (!d) return { removedSale: false };
  const saleTxId = d.saleTxId;
  // 先清掉關聯再刪帳目，避免刪帳目的連動又把物品改一次
  await db.durables.update(id, { status: 'active', endDate: undefined, saleMinor: undefined, saleTxId: undefined, undoSale: undefined, updatedAt: now() });
  if (!saleTxId) return { removedSale: false };
  const tx = await db.transactions.get(saleTxId);
  if (!tx || tx.deletedAt) return { removedSale: false };
  await deleteTransactions([saleTxId]);
  return { removedSale: true };
}

/** 這筆帳目關聯的耐用品（沒有或已刪除則回傳 undefined） */
export const durableOfTx = (txId: string) => db.durables.where('txId').equals(txId).filter((d) => !d.deletedAt).first();

/** 耐用品的成本：分帳只算我的份額，其餘用主幣別金額 */
export const durableCostOf = (tx: Transaction) =>
  tx.split ? Math.round((tx.baseAmountMinor * tx.split.myShareMinor) / Math.max(1, tx.amountMinor)) : tx.baseAmountMinor;

/**
 * 讓耐用品跟著帳目：編輯帳目時呼叫。
 * lifeYears > 0：沒有就新增、有就更新（成本、購入日、期限都跟著帳目的金額與日期）；
 * lifeYears = 0：取消耐用品標記（刪除關聯的物品，帳目不動）；
 * lifeYears < 0：只讓成本與購入日跟著帳目，期限維持原樣（原本就沒設定期限的物品）。
 */
export async function syncTxDurable(tx: Transaction, lifeYears: number, meta: { name: string; icon: string }): Promise<void> {
  const cur = await durableOfTx(tx.id);
  if (lifeYears < 0) {
    if (cur) await updateDurable(cur.id, { costMinor: durableCostOf(tx), purchaseDate: tx.date });
  } else if (lifeYears > 0) {
    const patch = { costMinor: durableCostOf(tx), purchaseDate: tx.date, lifeYears };
    if (cur) await updateDurable(cur.id, patch);
    else await addDurable({ ...meta, ...patch, currency: (await getSetting('baseCurrency')) as string, txId: tx.id });
  } else if (cur) {
    await db.durables.delete(cur.id);
  }
}

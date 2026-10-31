/**
 * 耐用物品存取層：新增、修改、賣掉／淘汰（可同時記一筆二手賣出收入）、還原、累計使用次數。
 * 帳目的寫入一律走 repo/ledger（維護帳戶餘額）。
 */
import { db, uid } from '../schema';
import type { Durable, Transaction } from '../types';
import { addTransaction } from './ledger';

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

/** 復原成「還在用」（賣錯、反悔）；已記的收入不動，需要的話請到帳目刪除 */
export async function reopenDurable(id: string) {
  await db.durables.update(id, { status: 'active', endDate: undefined, saleMinor: undefined, saleTxId: undefined, updatedAt: now() });
}

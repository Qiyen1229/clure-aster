/**
 * 帳目對帳戶餘額的影響、日／期間收支小計。純函式，供 repo 層與 UI 共用並有單元測試。
 */
import type { Transaction, Transfer } from '@/db/types';

/** 單筆帳目對其帳戶餘額的變動量（帳戶幣別最小單位） */
export function txEffect(tx: Pick<Transaction, 'type' | 'accountAmountMinor'>): number {
  switch (tx.type) {
    case 'income':
      return tx.accountAmountMinor;
    case 'expense':
    case 'transfer_fee':
      return -tx.accountAmountMinor;
    case 'adjust':
      return tx.accountAmountMinor; // 已帶正負號
  }
}

/** 轉帳對兩個帳戶的變動量 */
export function transferEffects(tr: Pick<Transfer, 'fromAccountId' | 'toAccountId' | 'fromAmountMinor' | 'toAmountMinor'>): [string, number][] {
  return [
    [tr.fromAccountId, -tr.fromAmountMinor],
    [tr.toAccountId, tr.toAmountMinor],
  ];
}

export interface Totals {
  expense: number;
  income: number;
  net: number;
  count: number;
}

/** 是否計入收支統計（餘額調整、標記排除者不計） */
export function countsInStats(tx: Pick<Transaction, 'type' | 'excludeFromStats' | 'deletedAt'>): boolean {
  return !tx.deletedAt && tx.type !== 'adjust' && !tx.excludeFromStats;
}

/** 計入統計的主幣別金額：分帳時只算「我的份額」 */
export function statAmount(tx: Pick<Transaction, 'baseAmountMinor' | 'amountMinor' | 'split'>): number {
  if (!tx.split || tx.amountMinor === 0) return tx.baseAmountMinor;
  return Math.round((tx.baseAmountMinor * tx.split.myShareMinor) / tx.amountMinor);
}

/** 以主幣別金額計算收支小計；轉帳手續費算支出 */
export function totals(txs: Iterable<Transaction>): Totals {
  let expense = 0;
  let income = 0;
  let count = 0;
  for (const t of txs) {
    if (!countsInStats(t)) continue;
    count++;
    if (t.type === 'income') income += statAmount(t);
    else expense += statAmount(t);
  }
  return { expense, income, net: income - expense, count };
}

/** 依日期分組小計，回傳 Map<date, Totals> */
export function totalsByDay(txs: Iterable<Transaction>): Map<string, Totals> {
  const map = new Map<string, Transaction[]>();
  for (const t of txs) {
    const arr = map.get(t.date);
    if (arr) arr.push(t);
    else map.set(t.date, [t]);
  }
  const out = new Map<string, Totals>();
  for (const [d, arr] of map) out.set(d, totals(arr));
  return out;
}

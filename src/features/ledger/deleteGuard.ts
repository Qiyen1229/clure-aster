/**
 * 刪除前的二次確認：一般帳目直接刪（有「復原」可挽回），只有「刪錯代價高」的才先問一次——
 * 金額大、附有收據／照片、分帳（牽涉欠款）。
 */
import { db } from '@/db/schema';
import { currencyInfo, formatMoney } from '@/domain/money';
import { useSettings } from '@/stores/settings';
import type { Transaction, Transfer } from '@/db/types';

/** 主幣別金額達此數字（整數元）就算大額 */
export const LARGE_AMOUNT = 10000;

export function deleteWarning(x: { tx: Transaction } | { tr: Transfer }, base = useSettings.getState().baseCurrency): string | null {
  const exp = currencyInfo(base).exp;
  const large = (minor: number) => Math.abs(minor) >= LARGE_AMOUNT * 10 ** exp;
  if ('tx' in x) {
    const t = x.tx;
    const why: string[] = [];
    if (large(t.baseAmountMinor)) why.push(`金額較大（${formatMoney(t.baseAmountMinor, base)}）`);
    if (t.attachmentIds?.length) why.push(`附有 ${t.attachmentIds.length} 張收據／照片`);
    if (t.split) why.push('是分帳帳目，會一併移除相關欠款');
    return why.length ? why.join('、') : null;
  }
  return large(x.tr.fromAmountMinor) ? `轉帳金額較大（${formatMoney(x.tr.fromAmountMinor, base)}）` : null;
}

/** 需要確認時跳出確認框；回傳是否可以刪除 */
export function confirmDelete(x: { tx: Transaction } | { tr: Transfer }): boolean {
  const why = deleteWarning(x);
  return !why || window.confirm(`確定要刪除這筆帳目嗎？\n${why}`);
}

export async function confirmDeleteById(kind: 'tx' | 'transfer', id: string): Promise<boolean> {
  const row = kind === 'tx' ? await db.transactions.get(id) : await db.transfers.get(id);
  if (!row) return true;
  return confirmDelete(kind === 'tx' ? { tx: row as Transaction } : { tr: row as Transfer });
}

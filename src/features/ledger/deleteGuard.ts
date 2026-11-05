/**
 * 刪除前的二次確認：一般帳目直接刪（有「復原」可挽回），只有「刪錯代價高」的才先問一次——
 * 金額大、附有收據／照片、分帳（牽涉欠款）。
 */
import { db } from '@/db/schema';
import { convertMinor, currencyInfo, formatMoney } from '@/domain/money';
import { resolveRate } from '@/services/fx';
import { useSettings } from '@/stores/settings';
import type { Transaction, Transfer } from '@/db/types';

/** 主幣別金額達此數字（整數元）就算大額 */
export const LARGE_AMOUNT = 10000;

/** 轉帳 x.baseMinor：換算成主幣別的金額（沒有匯率可換算為 null）；沒給就當轉出帳戶幣別＝主幣別 */
export type DeleteTarget = { tx: Transaction } | { tr: Transfer; baseMinor?: number | null };

export function deleteWarning(x: DeleteTarget, base = useSettings.getState().baseCurrency): string | null {
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
  // 轉出金額是「轉出帳戶幣別」：要先換算成主幣別才能比大小與顯示，否則 JPY 15,000 會被當成 NT$15,000
  const baseMinor = x.baseMinor === undefined ? x.tr.fromAmountMinor : x.baseMinor;
  return baseMinor !== null && large(baseMinor) ? `轉帳金額較大（${formatMoney(baseMinor, base)}）` : null;
}

/** 轉帳要先把轉出金額換成主幣別（讀帳戶與匯率），再判斷要不要確認 */
export async function withTransferBase(x: DeleteTarget, base = useSettings.getState().baseCurrency): Promise<DeleteTarget> {
  if ('tx' in x) return x;
  const from = await db.accounts.get(x.tr.fromAccountId);
  if (!from || from.currency === base) return { tr: x.tr, baseMinor: x.tr.fromAmountMinor };
  const rate = resolveRate(new Map((await db.exchange_rates.toArray()).map((r) => [`${r.base}>${r.quote}`, r])), from.currency, base);
  return { tr: x.tr, baseMinor: rate ? convertMinor(x.tr.fromAmountMinor, from.currency, base, rate) : null };
}

/** 需要確認時跳出確認框；回傳是否可以刪除 */
export function confirmDelete(x: DeleteTarget): boolean {
  const why = deleteWarning(x);
  return !why || window.confirm(`確定要刪除這筆帳目嗎？\n${why}`);
}

export async function confirmDeleteById(kind: 'tx' | 'transfer', id: string): Promise<boolean> {
  const row = kind === 'tx' ? await db.transactions.get(id) : await db.transfers.get(id);
  if (!row) return true;
  return confirmDelete(await withTransferBase(kind === 'tx' ? { tx: row as Transaction } : { tr: row as Transfer }));
}

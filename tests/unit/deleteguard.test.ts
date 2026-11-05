import { describe, expect, it } from 'vitest';
import { deleteWarning } from '@/features/ledger/deleteGuard';
import type { Transaction, Transfer } from '@/db/types';

const tx = (p: Partial<Transaction>) => ({ amountMinor: 100, baseAmountMinor: 100, attachmentIds: [], ...p }) as Transaction;

describe('刪除二次確認', () => {
  it('一般小額帳目不需確認', () => {
    expect(deleteWarning({ tx: tx({}) }, 'TWD')).toBeNull();
    expect(deleteWarning({ tx: tx({ baseAmountMinor: 999_900 }) }, 'TWD')).toBeNull();
  });
  it('金額達 10,000 元要確認', () => {
    expect(deleteWarning({ tx: tx({ baseAmountMinor: 1_000_000 }) }, 'TWD')).toContain('金額較大');
  });
  it('有收據或分帳要確認', () => {
    expect(deleteWarning({ tx: tx({ attachmentIds: ['a'] }) }, 'TWD')).toContain('1 張收據');
    expect(deleteWarning({ tx: tx({ split: { myShareMinor: 50, debtIds: [] } }) }, 'TWD')).toContain('分帳');
  });
  it('大額轉帳要確認', () => {
    expect(deleteWarning({ tr: { fromAmountMinor: 5_000_000 } as Transfer }, 'TWD')).toContain('轉帳金額較大');
    expect(deleteWarning({ tr: { fromAmountMinor: 500 } as Transfer }, 'TWD')).toBeNull();
  });
  it('外幣轉帳要先換成主幣別再比大小與顯示（不能把 JPY 15,000 當成 NT$15,000）', () => {
    const tr = { fromAmountMinor: 1_500_000 } as Transfer; // JPY 1,500,000 的最小單位視幣別而定；這裡只看換算後的主幣別金額
    expect(deleteWarning({ tr, baseMinor: 320_000 }, 'TWD')).toBeNull(); // 換算後 NT$3,200：不用確認
    expect(deleteWarning({ tr, baseMinor: 3_200_000 }, 'TWD')).toContain('$32,000');
    expect(deleteWarning({ tr, baseMinor: null }, 'TWD')).toBeNull(); // 沒有匯率可換算：不亂猜
  });
});

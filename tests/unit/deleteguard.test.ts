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
});

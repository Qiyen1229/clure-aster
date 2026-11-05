import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction, deleteTransactions } from '@/db/repo/ledger';
import { reconcile } from '@/domain/reconcile';
import { applyFixes, loadLedgerRows, stmtFromAi, suggestForMissing } from '@/services/reconcile';

const cat = (id: string, name: string, kind = 'expense') => ({ id, name, kind, parentId: '', icon: '', color: '', sort: 0, archived: 0, createdAt: 1, updatedAt: 1 });

describe('對帳：載入、補齊、平帳、復原', () => {
  let acc = { id: '' } as never as Awaited<ReturnType<typeof addAccount>>;
  beforeEach(async () => {
    await db.delete(); await db.open();
    await db.categories.bulkAdd([cat('e-food', '飲食'), cat('e-fee', '銀行手續費'), cat('e-other', '其他'), cat('i-other', '其他', 'income')] as never);
    acc = await addAccount({ name: '玉山卡', icon: '', color: '', type: 'credit', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: true });
  });
  const tx = (date: string, yuan: number, note: string, extra: Record<string, unknown> = {}) =>
    addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'e-food', amountMinor: yuan * 100, currency: 'TWD', date, ts: 1, note, ...extra });
  const bal = async () => (await db.accounts.get(acc.id))!.balanceMinor;

  it('完整流程：吻合／漏記／匯差 → 一鍵補齊後再對一次全部吻合；復原回到原狀', async () => {
    await tx('2026-10-10', 120, '全聯');
    await tx('2026-10-12', 1600, 'Amazon', { currency: 'USD', amountMinor: 5000, fxRateDec: '32', accountAmountMinor: 160000 } as never);
    const stmt = stmtFromAi([
      { date: '2026-10-10', amount: 120, type: 'expense', merchant: '全聯福利中心', foreign_amount: null, foreign_currency: null },
      { date: '2026-10-12', amount: 1642, type: 'expense', merchant: 'AMAZON.COM', foreign_amount: 50, foreign_currency: 'USD' },
      { date: '2026-10-15', amount: 150, type: 'expense', merchant: '海外交易手續費', foreign_amount: null, foreign_currency: null },
    ], 'TWD');
    const rep = reconcile(stmt, await loadLedgerRows(acc.id, stmt), 'TWD');
    expect(rep.matched).toHaveLength(1);
    expect(rep.variances).toHaveLength(1);
    expect(rep.missing).toHaveLength(1);

    const before = await bal();
    const sug = await suggestForMissing(rep.missing);
    expect(sug.get(rep.missing[0].id)).toBe('e-fee'); // 「手續費」字眼 → 銀行手續費分類
    const ids = await applyFixes(acc as never, { missing: rep.missing.map((row) => ({ row, categoryId: sug.get(row.id)! })), variances: rep.variances, adjustTo: null });
    expect(ids).toHaveLength(2); // 補 1 筆漏記 ＋ 1 筆匯差
    const rep2 = reconcile(stmt, await loadLedgerRows(acc.id, stmt), 'TWD');
    // 漏記已補、匯差已另記一筆差額（原帳目不動、併回原帳目）：再對一次全部吻合
    expect(rep2.missing).toHaveLength(0);
    expect(rep2.variances).toHaveLength(0);
    expect(rep2.matched).toHaveLength(3);
    const fee = (await db.transactions.toArray()).find((t) => t.note.includes('匯差／手續費調整'));
    expect(fee?.amountMinor).toBe(4200); // NT$42
    expect(await bal()).toBe(before - 15000 - 4200); // 負債帳戶：欠款增加

    await deleteTransactions(ids);
    expect(await bal()).toBe(before);
  });

  it('校正餘額：補齊後與實際餘額還有差，才補一筆餘額調整（負債帳戶為負數）', async () => {
    await tx('2026-10-10', 100, 'A');
    const cur = await bal(); // -10000
    const ids = await applyFixes(acc as never, { missing: [], variances: [], adjustTo: -12000 });
    expect(ids).toHaveLength(1);
    expect(await bal()).toBe(-12000);
    expect((await db.transactions.get(ids[0]))?.type).toBe('adjust');
    expect(cur).toBe(-10000);
    expect(await applyFixes(acc as never, { missing: [], variances: [], adjustTo: -12000 })).toHaveLength(0); // 已經一樣：不再補
  });

  it('載入帳本：只含這個帳戶、帳單期間前後 3 天內、未刪除的收支', async () => {
    const other = await addAccount({ name: '現金', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
    await tx('2026-10-10', 1, '在範圍');
    await tx('2026-10-30', 1, '太遠');
    await addTransaction({ type: 'expense', accountId: other.id, categoryId: 'e-food', amountMinor: 100, currency: 'TWD', date: '2026-10-10', ts: 1, note: '別的帳戶' });
    const gone = await tx('2026-10-11', 1, '已刪除'); await deleteTransactions([gone.id]);
    const rows = await loadLedgerRows(acc.id, [{ id: 's', date: '2026-10-10', amountMinor: 1, kind: 'expense', text: '' }]);
    expect(rows.map((r) => r.text)).toEqual(['在範圍']);
  });
});

/**
 * 使用者回報問題的回歸測試
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction, updateTransaction } from '@/db/repo/ledger';
import { addDebts, findOrCreatePerson, settleDebt, unsettleDebt } from '@/db/repo/plan';
import { normDate } from '@/services/importer';
import { exchangeDateOf } from '@/services/quotes/providers';
import { totals } from '@/domain/ledger';

const bal = async (id: string) => (await db.accounts.get(id))!.balanceMinor;

describe('回歸測試', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
  });

  it('#1 編輯餘額調整：以「調整後餘額」重算差額，不會暴增', async () => {
    const a = await addAccount({ name: 'A', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 4800000, includeInNetWorth: true, isLiability: false });
    // 新增：目標 50,000 → 差額 +2,000
    const target1 = 5000000;
    const t = await addTransaction({ type: 'adjust', accountId: a.id, categoryId: 'sys-adjust', amountMinor: target1 - (await bal(a.id)), currency: 'TWD', date: '2026-10-10', ts: 1 });
    expect(await bal(a.id)).toBe(5000000);
    // 之後又記一筆支出 1,000，目前餘額 49,000
    await addTransaction({ type: 'expense', accountId: a.id, categoryId: 'exp-food', amountMinor: 100000, currency: 'TWD', date: '2026-10-10', ts: 2 });
    // 編輯（與 AddSheet 相同算法）：基準 = 目前餘額 − 原差額；新差額 = 目標 − 基準
    const old = (await db.transactions.get(t.id))!;
    const baseline = (await bal(a.id)) - old.accountAmountMinor; // 4,700,000
    const target2 = 5200000;
    await updateTransaction(t.id, { type: 'adjust', accountId: a.id, categoryId: 'sys-adjust', amountMinor: target2 - baseline, currency: 'TWD', date: '2026-10-10', ts: 1 });
    expect(await bal(a.id)).toBe(5200000); // 編輯後目前餘額＝輸入的目標，而非多出五萬
    expect((await db.transactions.get(t.id))!.amountMinor).toBe(500000);
  });

  it('#2 取消結清會刪除結清入帳，再次結清不會重複入帳', async () => {
    const a = await addAccount({ name: 'A', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
    const p = await findOrCreatePerson('小明');
    const [id] = await addDebts([{ personId: p.id, direction: 'i_owe_them', amountMinor: 30000, currency: 'TWD', date: '2026-10-01', note: '', categoryId: 'exp-food' }]);
    await settleDebt(id, a.id);
    expect(await bal(a.id)).toBe(-30000);
    await unsettleDebt(id);
    expect(await bal(a.id)).toBe(0);
    expect((await db.debts.get(id))!.settleTransferId).toBeUndefined();
    await settleDebt(id, a.id);
    expect(await bal(a.id)).toBe(-30000);
    expect(totals(await db.transactions.toArray()).expense).toBe(30000);
  });

  it('#3 CSV 日期：DD/MM/YYYY、MM/DD/YYYY、中文、非法日期', () => {
    expect(normDate('25/08/2024')).toBe('2024-08-25');
    expect(normDate('08/25/2024')).toBe('2024-08-25');
    expect(normDate('03/04/2024')).toBe('2024-03-04'); // 無法分辨時依 MM/DD
    expect(normDate('2024年8月5日')).toBe('2024-08-05');
    expect(normDate('2024-8-5 12:30')).toBe('2024-08-05');
    expect(normDate('2024-13-45')).toBeNull();
    expect(normDate('31/02/2024')).toBeNull();
    expect(normDate('2023/02/29')).toBeNull();
    expect(normDate('2024/02/29')).toBe('2024-02-29');
  });

  it('#4 Yahoo 時間戳以交易所時區換日期', () => {
    // 台股週線：台北 2026-10-05 00:00 = UTC 2026-10-04 16:00
    const tw = Date.UTC(2026, 9, 4, 16, 0) / 1000;
    expect(exchangeDateOf(tw, 28800)).toBe('2026-10-05');
    // 美股日線：紐約 09:30（EDT，−4h）= UTC 13:30
    const us = Date.UTC(2026, 9, 9, 13, 30) / 1000;
    expect(exchangeDateOf(us, -14400)).toBe('2026-10-09');
  });
});

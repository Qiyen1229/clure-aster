import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const aiPriceCheck = vi.fn();
const notify = vi.fn(async () => undefined);
vi.mock('@/services/ai', () => ({ aiPriceCheck: (...a: unknown[]) => aiPriceCheck(...a) }));
vi.mock('@/services/notifications', () => ({ notify: (...a: unknown[]) => notify(...(a as [])) }));

import { db } from '@/db/schema';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';
import { addDays, todayKey } from '@/domain/period';
import { checkNewTransactions, installNewTxWatcher, isFreshExpense, loadSnapshot, computeInsights } from '@/services/insights';

const today = todayKey();
const tx = (id: string, date: string, note: string, yuan: number, categoryId: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'expense', accountId: 'a1', categoryId, amountMinor: yuan * 100, baseAmountMinor: yuan * 100, accountAmountMinor: yuan * 100, currency: 'TWD',
  date, ts: new Date(`${date}T12:00:00`).getTime(), note, tagIds: [], attachmentIds: [], createdAt: Date.now(), updatedAt: Date.now(), ...extra,
});

describe('每新增一筆支出就檢查一次（先看習慣與分類市價，判斷不了才問 AI）', () => {
  beforeEach(async () => {
    vi.stubGlobal('document', { documentElement: { dataset: {} }, querySelectorAll: () => [] });
    aiPriceCheck.mockReset();
    notify.mockClear();
    for (const t of ['transactions', 'recurring_rules', 'budgets', 'categories', 'meta', 'reminders']) await db.table(t).clear();
    await db.categories.bulkAdd([
      { id: 'exp-food', kind: 'expense', name: '飲食', icon: '', color: '', sort: 0, system: 0 },
      { id: 'exp-food-lunch', kind: 'expense', name: '午餐', icon: '', color: '', sort: 0, system: 0, parentId: 'exp-food' },
      { id: 'exp-housing', kind: 'expense', name: '居住', icon: '', color: '', sort: 1, system: 0 },
      { id: 'exp-housing-furniture', kind: 'expense', name: '家具家電', icon: '', color: '', sort: 0, system: 0, parentId: 'exp-housing' },
      { id: 'exp-other', kind: 'expense', name: '其他', icon: '', color: '', sort: 2, system: 0 },
      { id: 'exp-pet', kind: 'expense', name: '寵物', icon: '', color: '', sort: 3, system: 0 },
    ] as never);
    useSettings.setState({ ...DEFAULT_SETTINGS, ai: { enabled: true, allowData: false, auto: false }, insights: { anomaly: true, budgetWarn: true, dismissed: [], aiPrice: true } } as never);
    // 平常的消費習慣：午餐約 120、其他類（雜項）約 150，各 30 筆
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => tx(`l${i}`, addDays(today, -(i + 3)), `午餐${i % 4}`, 100 + (i % 5) * 10, 'exp-food-lunch', { createdAt: 1 })),
      ...Array.from({ length: 30 }, (_, i) => tx(`o${i}`, addDays(today, -(i + 3)), `雜項${i % 4}`, 130 + (i % 5) * 10, 'exp-other', { createdAt: 1 })),
    ];
    await db.transactions.bulkAdd(rows as never);
  });

  it('吃飯突然 5200：規則直接判定超出行情 → 提醒並通知；不需要問 AI', async () => {
    await db.transactions.add(tx('new1', today, '海鮮餐廳', 5200, 'exp-food-lunch') as never);
    expect(await checkNewTransactions(['new1'])).toBe(1);
    expect(aiPriceCheck).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    const f = (await loadSnapshot())!.findings.find((x) => x.id === 'large:new1')!;
    expect(f.why).toContain('一般午餐一次消費大約 $60～$300');
  });

  it('買家電 45000（分類或備註寫明）：再大也不提醒、也不問 AI', async () => {
    await db.transactions.bulkAdd([
      tx('fridge', today, '冰箱', 45000, 'exp-housing-furniture'),
      tx('tuition', today, '學雜費', 38000, 'exp-other'), // 分類選「其他」，備註寫明
      tx('car', today, '買車 頭期款', 300000, 'exp-other'),
    ] as never);
    expect(await checkNewTransactions(['fridge', 'tuition', 'car'])).toBe(0);
    expect(aiPriceCheck).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('規則判斷不了（「其他」比平常高很多）→ 請 AI 查市價；AI 說偏高才提醒，說明用 AI 查到的行情', async () => {
    aiPriceCheck.mockResolvedValue({ verdict: 'high', typical_min: 200, typical_max: 900, reason: '一般這類一次不到 900 元' });
    await db.transactions.add(tx('x1', today, '不明消費', 1600, 'exp-other') as never);
    expect(await checkNewTransactions(['x1'])).toBe(1);
    expect(aiPriceCheck).toHaveBeenCalledTimes(1);
    expect(aiPriceCheck.mock.calls[0][0]).toMatchObject({ category: '其他', note: '不明消費', amount: 1600, currency: 'TWD' });
    const f = (await loadSnapshot())!.findings.find((x) => x.id === 'large:x1')!;
    expect(f.why).toContain('AI 查到一般行情約 $200～$900');
  });

  it('AI 說合理 → 不提醒；同一筆只問一次（再次檢查不會重複問，也不能手動重跑）', async () => {
    aiPriceCheck.mockResolvedValue({ verdict: 'reasonable', typical_min: 800, typical_max: 3000, reason: '' });
    await db.transactions.add(tx('x2', today, '寵物用品', 1600, 'exp-other') as never);
    expect(await checkNewTransactions(['x2'])).toBe(0);
    expect(await checkNewTransactions(['x2'])).toBe(0);
    expect(await checkNewTransactions(['x2'])).toBe(0);
    expect(aiPriceCheck).toHaveBeenCalledTimes(1);
  });

  it('沒有 AI 可問：不是離譜到極端就不提醒；極端才用本機判斷提醒', async () => {
    aiPriceCheck.mockResolvedValue(null);
    await db.transactions.bulkAdd([tx('m1', today, '不明消費', 700, 'exp-other'), tx('m2', today, '不明消費', 9000, 'exp-other')] as never);
    expect(await checkNewTransactions(['m1'])).toBe(0);
    expect(await checkNewTransactions(['m2'])).toBe(1);
  });

  it('關閉偵測就完全不檢查；一次最多只問 5 筆 AI', async () => {
    useSettings.setState({ insights: { anomaly: false, budgetWarn: true, dismissed: [], aiPrice: true } } as never);
    await db.transactions.add(tx('off1', today, '海鮮餐廳', 5200, 'exp-food-lunch') as never);
    expect(await checkNewTransactions(['off1'])).toBe(0);
    useSettings.setState({ insights: { anomaly: true, budgetWarn: true, dismissed: [], aiPrice: true } } as never);
    aiPriceCheck.mockResolvedValue({ verdict: 'reasonable', typical_min: null, typical_max: null, reason: '' });
    const many = Array.from({ length: 8 }, (_, i) => tx(`b${i}`, today, `不明${i}`, 1700 + i, 'exp-other'));
    await db.transactions.bulkAdd(many as never);
    await checkNewTransactions(many.map((t) => t.id));
    expect(aiPriceCheck).toHaveBeenCalledTimes(5);
  });

  it('被略過的提醒不再出現；刪掉那筆帳目後提醒自動消失', async () => {
    await db.transactions.add(tx('gone', today, '海鮮餐廳', 5200, 'exp-food-lunch') as never);
    await checkNewTransactions(['gone']);
    expect((await computeInsights()).findings.some((f) => f.id === 'large:gone')).toBe(true);
    await db.transactions.update('gone', { deletedAt: Date.now() });
    expect((await computeInsights()).findings.some((f) => f.id === 'large:gone')).toBe(false);
  });

  it('只有剛剛新增的一般支出才算：同步下載的舊帳目、轉帳、分期、週期入帳都不算', () => {
    const now = Date.now();
    const base = { type: 'expense', createdAt: now - 1000 };
    expect(isFreshExpense(base, now)).toBe(true);
    expect(isFreshExpense({ ...base, createdAt: now - 10 * 60_000 }, now)).toBe(false); // 舊帳目（例如其他裝置同步下來）
    expect(isFreshExpense({ ...base, type: 'income' }, now)).toBe(false);
    expect(isFreshExpense({ ...base, installmentId: 'i' }, now)).toBe(false);
    expect(isFreshExpense({ ...base, recurringRuleId: 'r' }, now)).toBe(false);
    expect(isFreshExpense({ ...base, transferId: 't' }, now)).toBe(false);
  });

  it('新增一筆支出後，系統自動檢查一次（Dexie hook，1.5 秒合併）', async () => {
    installNewTxWatcher();
    installNewTxWatcher(); // 重複安裝不會重複觸發
    await db.transactions.add(tx('auto1', today, '海鮮餐廳', 5200, 'exp-food-lunch') as never);
    await new Promise((r) => setTimeout(r, 2200));
    expect((await loadSnapshot())?.findings.some((f) => f.id === 'large:auto1')).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    // 舊帳目（createdAt 很早）不會觸發
    notify.mockClear();
    await db.transactions.add(tx('old1', today, '海鮮餐廳', 5300, 'exp-food-lunch', { createdAt: 5 }) as never);
    await new Promise((r) => setTimeout(r, 2200));
    expect(notify).not.toHaveBeenCalled();
  }, 15000);
});

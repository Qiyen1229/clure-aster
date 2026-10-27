/**
 * v1.2：自動分類（規則、商家記憶）、銀行對帳單匯入（支出／存入分欄、民國年、重複偵測）、電子發票解析
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildMemory, matchRule, normText, recallCategory, ruleMatches, type RuleLike } from '@/domain/rules';
import { enrichRows, normDate, parseRows, autoMap } from '@/services/importer';
import { invoiceNote, isVoided, parseEinvoiceCsv, parseInvoiceQR } from '@/services/einvoice';
import { db } from '@/db/schema';
import { bootstrap } from '@/db/bootstrap';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction } from '@/db/repo/ledger';
import { invalidateAutocat, saveRule, suggestCategory } from '@/services/autocat';

const rule = (p: Partial<RuleLike>): RuleLike => ({ id: 'r', keyword: '', match: 'contains', kind: 'expense', categoryId: 'c', priority: 100, ...p });

describe('自動分類規則', () => {
  it('正規化：全形、大小寫、空白與標點', () => {
    expect(normText('全家 ＦａｍｉｌｙＭａｒｔ！')).toBe('全家familymart');
  });
  it('包含／完全相同／正規表示式；停用與類型不符不比對', () => {
    expect(ruleMatches(rule({ keyword: '全聯' }), '全聯福利中心 信義店')).toBe(true);
    expect(ruleMatches(rule({ keyword: '全聯', match: 'equals' }), '全聯福利中心')).toBe(false);
    expect(ruleMatches(rule({ keyword: '^uber', match: 'regex' }), 'UBER *TRIP')).toBe(true);
    expect(ruleMatches(rule({ keyword: '[壞', match: 'regex' }), '任何')).toBe(false);
    expect(ruleMatches(rule({ keyword: '全聯', enabled: false }), '全聯')).toBe(false);
    expect(matchRule([rule({ keyword: '薪水', kind: 'income' })], '薪水', 'expense')).toBeUndefined();
  });
  it('優先順序小者先；同優先時關鍵字較長者先', () => {
    const rules = [rule({ id: 'a', keyword: '星巴克', categoryId: 'coffee' }), rule({ id: 'b', keyword: '星巴克 禮物卡', categoryId: 'gift' }), rule({ id: 'c', keyword: '禮物卡', categoryId: 'x', priority: 10 })];
    expect(matchRule(rules, '星巴克 禮物卡 加值', 'expense')!.id).toBe('c');
    expect(matchRule(rules.slice(0, 2), '星巴克 禮物卡 加值', 'expense')!.id).toBe('b');
  });
  it('商家記憶：次數多者勝、前綴比對', () => {
    const idx = buildMemory([
      { text: '星巴克', categoryId: 'coffee', kind: 'expense', ts: 1 },
      { text: '星巴克', categoryId: 'coffee', kind: 'expense', ts: 2 },
      { text: '星巴克', categoryId: 'snack', kind: 'expense', ts: 3 },
    ]);
    expect(recallCategory(idx, '星巴克', 'expense')).toBe('coffee');
    expect(recallCategory(idx, '星巴克 拿鐵大杯', 'expense')).toBe('coffee');
    expect(recallCategory(idx, '星巴克', 'income')).toBeUndefined();
    expect(recallCategory(idx, '星', 'expense')).toBeUndefined();
  });
});

describe('銀行對帳單匯入', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await bootstrap();
    invalidateAutocat();
  });

  it('民國年與連續數字日期', () => {
    expect(normDate('113/10/01')).toBe('2024-10-01');
    expect(normDate('民國113年2月29日')).toBe('2024-02-29');
    expect(normDate('1131001')).toBe('2024-10-01');
    expect(normDate('20241001')).toBe('2024-10-01');
    expect(normDate('113/02/30')).toBeNull();
  });

  it('支出、存入分兩欄＋摘要自動對應；信用卡正數為支出', () => {
    const head = ['交易日期', '摘要', '支出', '存入', '餘額'];
    const { mapping } = autoMap(head);
    expect(mapping).toMatchObject({ date: 0, note: 1, debit: 2, credit: 3 });
    const rows = parseRows([['113/10/01', '全聯', '1,250', '', '9000'], ['113/10/02', '薪資', '', '50,000', '59000']], mapping, { currency: 'TWD', account: '銀行' });
    expect(rows.map((r) => [r.kind, r.amount.toString(), r.date])).toEqual([['expense', '1250', '2024-10-01'], ['income', '50000', '2024-10-02']]);
    const card = parseRows([['2024/10/03', 'UBER', '320'], ['2024/10/04', '退款', '-100']], { date: 0, note: 1, amount: 2 }, { currency: 'TWD', account: '卡' }, { positiveIsExpense: true });
    expect(card.map((r) => r.kind)).toEqual(['expense', 'income']);
  });

  it('疑似重複與自動分類', async () => {
    const acc = await addAccount({ name: '玉山', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
    await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 125000, currency: 'TWD', date: (await import('@/domain/period')).todayKey(), ts: 1, note: '全聯' });
    await saveRule({ keyword: 'uber', match: 'contains', kind: 'expense', categoryId: 'exp-transport', priority: 100, enabled: true });
    const { addDays, todayKey } = await import('@/domain/period');
    const d = (n: number) => addDays(todayKey(), n);
    const rows = parseRows([[d(-1), '全聯', '-1250'], [d(-5), 'UBER TRIP', '-320'], [d(-6), '全聯 信義', '-80']], { date: 0, note: 1, amount: 2 }, { currency: 'TWD', account: '玉山' });
    const out = await enrichRows(rows);
    expect(out[0].dup).toBeTruthy();
    expect(out[1].dup).toBeUndefined();
    expect(out[1].autoCategoryId).toBe('exp-transport');
    expect(out[2].autoCategoryId).toBe('exp-food'); // 商家記憶（前綴）
    expect((await suggestCategory('Uber Eats', 'expense'))?.source).toBe('rule');
  });
});

describe('電子發票', () => {
  it('紙本發票左側 QR Code（UTF-8 品名）', () => {
    const qr = 'AB12345678' + '1151026' + '1234' + '00000050' + '00000055' + '00000000' + '12345678' + 'A'.repeat(24) + ':**********:2:2:1:拿鐵:1:45:三明治:1:40';
    const inv = parseInvoiceQR(qr)!;
    expect(inv).toMatchObject({ number: 'AB12345678', date: '2026-10-26', amount: 85, sellerId: '12345678' });
    expect(inv.items.map((i) => i.name)).toEqual(['拿鐵', '三明治']);
    expect(invoiceNote(inv)).toBe('拿鐵、三明治');
    expect(parseInvoiceQR('**:拿鐵:1:45')).toBeNull();
  });
  it('載具消費明細（M／D 列）', () => {
    const csv = [
      '表頭=M|載具名稱|載具號碼|發票日期|商店統編|商店店名|發票號碼|總金額|發票狀態|',
      '表頭=D|發票號碼|小計|品項名稱|',
      'M|手機條碼|/ABC1234|20261001|12345678|統一超商|AB11111111|85|開立|',
      'D|AB11111111|45|拿鐵|',
      'D|AB11111111|40|飯糰|',
      'M|手機條碼|/ABC1234|20261002|87654321|全聯|CD22222222|300|作廢|',
    ].join('\n');
    const list = parseEinvoiceCsv(csv);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ number: 'AB11111111', date: '2026-10-01', amount: 85, sellerName: '統一超商' });
    expect(list[0].items).toHaveLength(2);
    expect(isVoided(list[1])).toBe(true);
  });
});

describe('財務自由試算', () => {
  it('可重現、機率遞增、存越多越早達成', async () => {
    const { simulateFire } = await import('@/domain/fire');
    const base = { currentAge: 30, retireAge: 50, endAge: 90, netWorth: 1_000_000, annualExpense: 600_000, annualSaving: 400_000, expectedReturn: 0.06, volatility: 0.15, inflation: 0.02, withdrawalRate: 0.04, runs: 500, seed: 7 };
    const a = simulateFire(base);
    expect(simulateFire(base)).toEqual(a);
    for (let i = 1; i < a.fiProbability.length; i++) expect(a.fiProbability[i]).toBeGreaterThanOrEqual(a.fiProbability[i - 1]);
    expect(a.target[0]).toBe(15_000_000);
    expect(a.medianFiAge).not.toBeNull();
    const more = simulateFire({ ...base, annualSaving: 800_000 });
    expect(more.medianFiAge!).toBeLessThan(a.medianFiAge!);
    expect(more.retireSuccess).toBeGreaterThanOrEqual(a.retireSuccess);
    // 沒有波動時，模擬中位數＝確定性試算
    const flat = simulateFire({ ...base, volatility: 0 });
    expect(flat.medianFiAge).toBe(flat.deterministicFiAge);
  });
});

describe('稅務彙總', () => {
  it('累進稅額與股利課稅方式比較', async () => {
    const { progressiveTax, summarizeTax, DEFAULT_TAX_PARAMS } = await import('@/domain/tax');
    expect(progressiveTax(590_000, DEFAULT_TAX_PARAMS.brackets)).toBe(29_500);
    expect(progressiveTax(1_000_000, DEFAULT_TAX_PARAMS.brackets)).toBe(29_500 + 49_200);
    const inc = { domesticDividend: 200_000, nhi: 0, foreignDividend: 0, foreignWithholding: 0, foreignRealized: 0, domesticRealized: 0 };
    // 低所得：合併計稅（5% − 8.5% 抵減 → 退稅）較划算
    const low = summarizeTax(inc, { ...DEFAULT_TAX_PARAMS, netIncome: 300_000 });
    expect(low.better).toBe('combined');
    expect(low.combined.net).toBe(10_000 - 17_000);
    // 高所得（40%）：分開 28% 較划算
    const high = summarizeTax({ ...inc, domesticDividend: 3_000_000 }, { ...DEFAULT_TAX_PARAMS, netIncome: 6_000_000 });
    expect(high.better).toBe('separate');
  });
  it('海外所得未達 100 萬不計入；超過且基本所得額高時需補繳', async () => {
    const { summarizeTax, DEFAULT_TAX_PARAMS } = await import('@/domain/tax');
    const z = { domesticDividend: 0, nhi: 0, foreignWithholding: 0, domesticRealized: 0 };
    expect(summarizeTax({ ...z, foreignDividend: 300_000, foreignRealized: 600_000 }, { ...DEFAULT_TAX_PARAMS, netIncome: 9_000_000 }).overseasIncluded).toBe(false);
    const big = summarizeTax({ ...z, foreignDividend: 1_000_000, foreignRealized: 9_000_000 }, { ...DEFAULT_TAX_PARAMS, netIncome: 2_000_000 });
    expect(big.overseasIncluded).toBe(true);
    expect(big.basicTax).toBe(Math.round((12_000_000 - 7_500_000) * 0.2));
    expect(big.amtDue).toBeGreaterThan(0);
  });
});

describe('貸款攤還', () => {
  it('應剩本金、提前還款、利息拆分', async () => {
    const { loanStatus, splitPayment } = await import('@/domain/loan');
    const loan = { kind: 'mortgage' as const, principalMinor: 1_000_000_00, aprDec: '2.4', termMonths: 240, firstPaymentDate: '2025-01-10' };
    const st = loanStatus(loan, -990_000_00, '2025-03-15')!;
    expect(st.paidPeriods).toBe(3);
    expect(st.paymentMinor).toBeGreaterThan(5_200_00);
    expect(st.paymentMinor).toBeLessThan(5_300_00);
    expect(st.scheduledBalanceMinor).toBeLessThan(loan.principalMinor);
    expect(st.payoffDate).toBe('2044-12-10');
    expect(st.prepaidMinor).toBe(Math.max(0, st.scheduledBalanceMinor - 990_000_00));
    // 欠 100 萬、年利率 2.4% → 當月利息 2,000 元
    expect(splitPayment(-1_000_000_00, '2.4', 5_250_00)).toEqual({ interestMinor: 2_000_00, principalMinor: 3_250_00 });
    // 最後一期不超還
    expect(splitPayment(-1_000_00, '2.4', 5_250_00).principalMinor).toBe(1_000_00);
  });
});

describe('背景推播排程', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await bootstrap();
  });
  it('每日提醒：今天已記帳就從明天開始；只排未來 14 天內', async () => {
    const { useSettings } = await import('@/stores/settings');
    const { DEFAULT_SETTINGS } = await import('@/db/repo/settings');
    useSettings.setState({ ...DEFAULT_SETTINGS, notify: { ...DEFAULT_SETTINGS.notify, daily: true, dailyTime: '21:00', cardDue: false, subscription: false, backup: false } });
    const { upcomingPushItems } = await import('@/services/push');
    const { todayKey } = await import('@/domain/period');
    const today = todayKey();
    const now = new Date(`${today}T08:00:00`).getTime();
    const before = await upcomingPushItems(14, now);
    expect(before[0].id).toBe(`daily:${today}`);
    expect(before.every((i) => i.at > now && i.at <= now + 14 * 86400_000)).toBe(true);
    const acc = await addAccount({ name: '錢包', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
    await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 100, currency: 'TWD', date: today, ts: now, note: '' });
    const after = await upcomingPushItems(14, now);
    expect(after.some((i) => i.id === `daily:${today}`)).toBe(false);
  });
});

describe('文字大小設定', () => {
  it('只屬於這台裝置：不進同步佇列', async () => {
    const { saveSetting } = await import('@/db/repo/settings');
    await db.delete();
    await db.open();
    await saveSetting('fontSize', 21);
    await saveSetting('theme', 'dark');
    expect(await db.sync_outbox.get('settings|"fontSize"')).toBeUndefined();
    expect(await db.sync_outbox.get('settings|"theme"')).toBeDefined();
  });
});

describe('電子發票記帳：帳戶判斷與對到手動記帳', () => {
  it('規則指定帳戶 → 商家記憶 → 預設帳戶；手動記過的補上發票號碼', async () => {
    const { importInvoices } = await import('@/services/einvoice');
    const { todayKey, addDays } = await import('@/domain/period');
    await db.delete();
    await db.open();
    await bootstrap();
    invalidateAutocat();
    const mk = (name: string) => addAccount({ name, icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
    const cash = await mk('現金'), pay = await mk('全支付'), card = await mk('信用卡');
    const d = (n: number) => addDays(todayKey(), n);
    await saveRule({ keyword: '全聯', match: 'contains', kind: 'expense', categoryId: 'exp-shopping-daily', accountId: pay.id, priority: 100, enabled: true });
    // 過去在星巴克都用信用卡
    for (let i = 0; i < 3; i++) await addTransaction({ type: 'expense', accountId: card.id, categoryId: 'exp-food-drink', amountMinor: 15000, currency: 'TWD', date: d(-20 - i), ts: i, note: '星巴克' });
    // 手動記過的 7-11 85 元（沒有發票號碼）
    const manual = await addTransaction({ type: 'expense', accountId: cash.id, categoryId: 'exp-food', amountMinor: 8500, currency: 'TWD', date: d(-1), ts: 9, note: '早餐' });
    invalidateAutocat();
    const inv = (number: string, sellerName: string, amount: number, date: string) => ({ number, date, amount, sellerId: '', sellerName, status: '已確認', items: [] });
    const r = await importInvoices([
      inv('AA00000001', '全聯實業', 356, d(-2)),
      inv('AA00000002', '星巴克 信義', 150, d(-2)),
      inv('AA00000003', '統一超商', 85, d(0)),
      inv('AA00000004', '不知名小店', 60, d(-3)),
    ], { defaultAccountId: cash.id });
    expect(r).toMatchObject({ created: 3, matched: 1, skipped: 0, usedDefault: 1 });
    const all = await db.transactions.toArray();
    const by = (n: string) => all.find((t) => t.invoiceNo === n)!;
    expect(by('AA00000001')).toMatchObject({ accountId: pay.id, categoryId: 'exp-shopping-daily' });
    expect(by('AA00000002')).toMatchObject({ accountId: card.id, categoryId: 'exp-food-drink' });
    expect(by('AA00000003').id).toBe(manual.id); // 對到手動記帳，不新增
    expect(by('AA00000004').accountId).toBe(cash.id);
    // 再匯入一次全部略過
    expect((await importInvoices([inv('AA00000001', '全聯實業', 356, d(-2))], { defaultAccountId: cash.id })).skipped).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { detectInsights, detectPeriod, merchantKey, surgeWindows, type DetectInput } from '@/domain/anomaly';
import { addDays } from '@/domain/period';
import type { Transaction } from '@/db/types';

const today = '2026-10-31';
let n = 0;
const tx = (date: string, note: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id: `t${++n}`, type: 'expense', accountId: 'a1', categoryId: 'exp-food-lunch', amountMinor: amount * 100, currency: 'TWD',
  accountAmountMinor: amount * 100, baseAmountMinor: amount * 100, date, ts: new Date(`${date}T12:00:00`).getTime(),
  note, tagIds: [], attachmentIds: [], createdAt: 0, updatedAt: 0, ...extra,
});
const fmt = (m: number) => `$${Math.round(m / 100)}`;
const base = (txs: Transaction[], rules: DetectInput['rules'] = []): DetectInput => ({
  txs, rules, today, fmt, catName: () => '飲食', mainOf: (c) => c.split('-').slice(0, 2).join('-'),
});
/** 每天一筆平常的午餐（讓「異常」有可以比較的基準） */
const filler = (days: number, amount = 120, offset = 0) => Array.from({ length: days }, (_, i) => tx(addDays(today, -(i + offset)), `午餐${i % 5}`, amount + (i % 3) * 10, { categoryId: 'exp-food-lunch' }));
const monthly = (note: string, amounts: number[], day = '05') =>
  amounts.map((a, i) => tx(`2026-${String(10 - (amounts.length - 1 - i)).padStart(2, '0')}-${day}`, note, a, { categoryId: 'exp-subscription-video' }));

describe('訂閱偵測', () => {
  it('每月固定金額的扣款 → 發現新訂閱，附白話說明與一年總額', () => {
    const f = detectInsights(base([...filler(40), ...monthly('Netflix', [330, 330, 330, 330, 330])])).find((x) => x.kind === 'subscription');
    expect(f).toBeTruthy();
    expect(f!.subscription).toMatchObject({ name: 'Netflix', period: 'month', amountMinor: 33000 });
    expect(f!.why).toContain('一年大約是 $3960');
    expect(f!.title).toContain('每月');
  });
  it('已經登記成訂閱的不會重複提醒（名稱相近也算）', () => {
    const f = detectInsights(base([...filler(40), ...monthly('Netflix 月費', [330, 330, 330, 330])], [{ name: 'Netflix' }]));
    expect(f.find((x) => x.kind === 'subscription')).toBeUndefined();
  });
  it('金額忽高忽低、或間隔不固定的消費不是訂閱', () => {
    const coffee = ['2026-10-01', '2026-10-04', '2026-10-05', '2026-10-12', '2026-10-13', '2026-10-27'].map((d, i) => tx(d, '星巴克', 120 + i * 40));
    expect(detectInsights(base([...filler(40), ...coffee])).find((x) => x.kind === 'subscription')).toBeUndefined();
  });
  it('已經很久沒扣的不算（可能已取消）', () => {
    const old = ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05'].map((d) => tx(d, '舊服務', 199));
    expect(detectInsights(base([...filler(40), ...old])).find((x) => x.kind === 'subscription')).toBeUndefined();
  });
  it('每年一次的扣款（兩次相隔一年）也找得到', () => {
    const y = [tx('2025-10-20', 'iCloud 年費', 1200), tx('2026-10-20', 'iCloud 年費', 1200)];
    // 年費要在近 14 個月內：2025-10-20 距今約 376 天
    const f = detectInsights(base([...filler(40), ...y])).find((x) => x.kind === 'subscription');
    expect(f?.subscription?.period).toBe('year');
  });
  it('週期判斷', () => {
    expect(detectPeriod(['2026-07-05', '2026-08-05', '2026-09-04', '2026-10-05'])).toBe('month');
    expect(detectPeriod(['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24'])).toBe('week');
    expect(detectPeriod(['2026-10-01', '2026-10-09', '2026-10-30'])).toBeNull();
  });
});

describe('漲價', () => {
  it('270、270、270 之後變 330 → 漲價 22%，並算出一年多花多少', () => {
    const f = detectInsights(base([...filler(40), ...monthly('Spotify', [270, 270, 270, 330])])).find((x) => x.kind === 'price_up');
    expect(f).toBeTruthy();
    expect(f!.title).toContain('$270 → $330');
    expect(f!.why).toContain('22%');
    expect(f!.why).toContain('$720'); // (330-270)*12
  });
  it('小幅波動不算漲價', () => {
    expect(detectInsights(base([...filler(40), ...monthly('Spotify', [270, 270, 270, 273])])).find((x) => x.kind === 'price_up')).toBeUndefined();
  });
});

describe('重複扣款', () => {
  it('同店同帳戶同金額、隔天又一筆 → 疑似重複', () => {
    const f = detectInsights(base([...filler(40), tx('2026-10-20', '電影院', 560), tx('2026-10-21', '電影院', 560)])).filter((x) => x.kind === 'duplicate');
    expect(f).toHaveLength(1);
    expect(f[0].txIds).toHaveLength(2);
    expect(f[0].why).toContain('$560');
  });
  it('每天固定買的咖啡（習慣）不算重複', () => {
    const habit = Array.from({ length: 12 }, (_, i) => tx(addDays(today, -(i * 1)), '7-11 咖啡', 55));
    expect(detectInsights(base([...filler(40, 120, 12), ...habit])).filter((x) => x.kind === 'duplicate')).toHaveLength(0);
  });
  it('自動入帳的週期帳目 + 手動又記一筆（同金額同分類）→ 疑似重複', () => {
    const auto = tx('2026-10-05', '房租', 12000, { recurringRuleId: 'r1', categoryId: 'exp-housing-rent' });
    const manual = tx('2026-10-06', '房租', 12000, { categoryId: 'exp-housing-rent' });
    const f = detectInsights(base([...filler(40), auto, manual])).filter((x) => x.kind === 'duplicate');
    expect(f).toHaveLength(1);
    expect(f[0].why).toContain('週期帳目');
  });
  it('金額太小（小於 30 元）不提醒', () => {
    expect(detectInsights(base([...filler(40), tx('2026-10-20', '口香糖', 25), tx('2026-10-20', '口香糖', 25)])).filter((x) => x.kind === 'duplicate')).toHaveLength(0);
  });
});

describe('異常大額', () => {
  it('遠高於這個分類平常的一筆 → 提醒，說明是平常的幾倍', () => {
    const f = detectInsights(base([...filler(60), tx('2026-10-28', '海鮮餐廳', 4800)])).find((x) => x.kind === 'large');
    expect(f).toBeTruthy();
    expect(f!.title).toContain('$4800');
    expect(f!.why).toContain('倍');
  });
  it('正常範圍內的波動不提醒；資料太少（不到 30 筆）不判斷', () => {
    expect(detectInsights(base([...filler(60), tx('2026-10-28', '晚餐', 250)])).find((x) => x.kind === 'large')).toBeUndefined();
    expect(detectInsights(base([...filler(10), tx('2026-10-28', '海鮮餐廳', 4800)])).find((x) => x.kind === 'large')).toBeUndefined();
  });
  it('已登記的週期帳目（房租、保費）本來就大，不算異常', () => {
    expect(detectInsights(base([...filler(60), tx('2026-10-28', '保費', 20000, { recurringRuleId: 'r2' })])).find((x) => x.kind === 'large')).toBeUndefined();
  });
});

describe('分類暴增', () => {
  it('本月同期遠高於前三個月平均 → 提醒', () => {
    const month = (m: string, total: number) => Array.from({ length: 10 }, (_, i) => tx(`2026-${m}-${String(i + 1).padStart(2, '0')}`, '聚餐', total / 10, { categoryId: 'exp-food-dinner' }));
    const txs = [...filler(20, 100, 40), ...month('07', 4000), ...month('08', 4200), ...month('09', 3800), ...month('10', 9000)];
    const windows = surgeWindows({ start: '2026-10-01', end: '2026-10-31' }, '2026-10-10', ['2026-09-01', '2026-08-01', '2026-07-01']);
    const f = detectInsights({ ...base(txs), today: '2026-10-10', windows }).find((x) => x.kind === 'surge');
    expect(f).toBeTruthy();
    expect(f!.why).toContain('前三個月同樣這段時間平均');
  });
  it('月初（不到 7 天）不判斷', () => {
    const windows = surgeWindows({ start: '2026-10-01', end: '2026-10-31' }, '2026-10-05', ['2026-09-01', '2026-08-01']);
    expect(detectInsights({ ...base(filler(40)), windows }).find((x) => x.kind === 'surge')).toBeUndefined();
  });
});

describe('減少誤報', () => {
  it('房租這種每月固定的大額，不會被當成「異常大額」，而是被認成固定扣款', () => {
    const rent = ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'].map((d) => tx(d, '房租', 16000, { categoryId: 'exp-housing-rent' }));
    const f = detectInsights({ ...base([...filler(60), ...rent]), isSubscriptionCat: (c) => c.startsWith('exp-sub') });
    expect(f.find((x) => x.kind === 'large')).toBeUndefined();
    const r = f.find((x) => x.kind === 'subscription')!;
    expect(r.subscription!.kind).toBe('normal');
    expect(r.title).toContain('固定扣款');
    expect(r.tip).toContain('週期帳目');
  });
  it('分類是「訂閱」類 → 登記成訂閱', () => {
    const f = detectInsights({ ...base([...filler(40), ...monthly('Netflix', [330, 330, 330, 330])]), isSubscriptionCat: (c) => c.startsWith('exp-sub') });
    expect(f.find((x) => x.kind === 'subscription')!.subscription!.kind).toBe('subscription');
  });
  it('「午餐」「早餐」這類籠統備註不拿來判斷重複扣款（同金額一天內兩次很常見）', () => {
    const t = [tx('2026-10-20', '午餐', 120), tx('2026-10-21', '午餐', 120)];
    expect(detectInsights({ ...base([...filler(40, 150, 5), ...t]), genericKeys: new Set(['午餐']) }).filter((x) => x.kind === 'duplicate')).toHaveLength(0);
  });
});

describe('其他', () => {
  it('帳目不到 5 筆 → 不判斷；略過的項目會被濾掉；分期與轉帳不納入', () => {
    expect(detectInsights(base([tx('2026-10-01', 'a', 100)]))).toEqual([]);
    const all = detectInsights(base([...filler(40), ...monthly('Netflix', [330, 330, 330, 330])]));
    const sub = all.find((x) => x.kind === 'subscription')!;
    expect(detectInsights(base([...filler(40), ...monthly('Netflix', [330, 330, 330, 330])]), new Set([sub.id])).find((x) => x.id === sub.id)).toBeUndefined();
    const inst = monthly('分期', [1000, 1000, 1000, 1000]).map((t) => ({ ...t, installmentId: 'i1' }));
    expect(detectInsights(base([...filler(40), ...inst])).find((x) => x.kind === 'subscription')).toBeUndefined();
  });
  it('店家鍵：去掉數字、空白與「月費／訂閱」', () => {
    expect(merchantKey({ note: 'Netflix 月費 2026/10', merchant: '' })).toBe('netflix');
    expect(merchantKey({ note: '', merchant: 'Spotify 訂閱' })).toBe('spotify');
  });
  it('結果依嚴重程度排序：warn 在 info 前面', () => {
    const f = detectInsights(base([...filler(60), ...monthly('Netflix', [330, 330, 330, 330]), tx('2026-10-28', '海鮮餐廳', 4800)]));
    const first = f.findIndex((x) => x.severity === 'info');
    expect(f.slice(0, first).every((x) => x.severity === 'warn')).toBe(true);
  });
});

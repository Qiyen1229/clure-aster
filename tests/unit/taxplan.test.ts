import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { DEFAULT_TAX_PARAMS } from '@/domain/tax';
import { adviceOf, analyzeDividend, dividendTaxOf, incrementalTax, nhiFor, overseasAdvice, overseasWatch, sharesText, type DivEvent } from '@/domain/taxplan';
import { addDays, todayKey } from '@/domain/period';
import { loadTaxPlan, notifyUpcomingDividends } from '@/services/taxplan';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';

const P = (netIncome: number) => ({ ...DEFAULT_TAX_PARAMS, netIncome });
const ev = (over: Partial<DivEvent> = {}): DivEvent => ({ stockId: 's', symbol: '00878', name: '國泰永續高股息', assetType: 'etf', exDate: '2026-11-20', payDate: '2026-12-10', source: 'announced', shares: 15000, perShare: 1.4, price: 22, gross: 21000, ...over });

describe('二代健保與股利邊際稅額', () => {
  it('單次 ≥ 2 萬才扣 2.11%（全額）；差一點點不扣', () => {
    expect(nhiFor(19_999)).toBe(0);
    expect(nhiFor(20_000)).toBe(422);
    expect(nhiFor(21_000)).toBe(443); // 21,000 × 2.11%
  });
  it('邊際稅額：5% 級距的人，8.5% 抵減大於增加的稅 → 負的（可退稅）', () => {
    const t = incrementalTax(0, 21_000, P(500_000));
    expect(t).toBe(1050 - 1785); // 增加稅額 1,050 − 抵減 1,785 = −735
    expect(dividendTaxOf(21_000, P(500_000)).method).toBe('combined');
  });
  it('高所得者股利很大：抵減有上限 8 萬，分開計稅 28% 才比較省', () => {
    expect(dividendTaxOf(2_000_000, P(5_000_000)).method).toBe('separate');
  });
  it('其他股利已把抵減額度用滿時，這一筆沒有抵減可用（邊際稅額變正）', () => {
    const full = incrementalTax(1_000_000, 100_000, P(2_000_000)); // 其他股利 100 萬 → 抵減已 8.5 萬 > 上限 8 萬
    const empty = incrementalTax(0, 100_000, P(2_000_000));
    expect(full).toBeGreaterThan(empty);
  });
});

describe('分析與白話建議', () => {
  it('一般情況：建議直接參與除息，並寫出二代健保與退稅', () => {
    const a = analyzeDividend(ev(), 0, P(500_000), { sellFee: 400, sellTax: 300, buyFee: 400 });
    expect(a.nhi).toBe(443);
    expect(a.incTax).toBe(-735);
    expect(a.joinNet).toBe(21_000 - 443 + 735);
    expect(a.recommendation).toBe('join');
    const text = adviceOf(a).headline;
    expect(text).toContain('15 張 00878');
    expect(text).toContain('二代健保 443 元');
    expect(text).toContain('可退稅約 735 元');
    expect(text).toContain('建議直接參與除息、不必賣出');
  });
  it('棄息：預設保守——成本高、或省下的稅小於價格風險緩衝，就不建議', () => {
    // 高稅率、大額配息，但持股市值大 → 0.5% 風險緩衝比省下的稅還高
    const a = analyzeDividend(ev({ gross: 100_000, shares: 100_000, perShare: 1, price: 40 }), 0, P(3_000_000), { sellFee: 3420, sellTax: 4000, buyFee: 3420 });
    expect(a.skipAdvantage).toBeGreaterThan(0);
    expect(a.recommendation).toBe('join');
  });
  it('棄息：配息率很高、成本低、省稅多 → 提醒可以評估，但一定附上風險說明', () => {
    const a = analyzeDividend(ev({ gross: 100_000, shares: 100_000, perShare: 1, price: 10 }), 0, P(3_000_000), { sellFee: 20, sellTax: 30, buyFee: 20 });
    expect(a.recommendation).toBe('consider_skip');
    expect(a.skipAdvantage).toBe(Math.round(a.nhi + a.incTax - 70));
    const h = adviceOf(a).headline;
    expect(h).toContain('不保證划算');
    expect(h).toContain('股價波動');
  });
  it('沒有報價就不算棄息；接近門檻會標記 nhiNearMiss', () => {
    const a = analyzeDividend(ev({ gross: 17_000, price: 0 }), 0, P(500_000), null);
    expect(a.skipAdvantage).toBeNull();
    expect(a.nhiNearMiss).toBe(true);
    expect(a.nhi).toBe(0);
  });
  it('持股的白話寫法', () => { expect(sharesText(15000)).toBe('15 張'); expect(sharesText(1500)).toBe('1,500 股'); });
});

describe('海外所得控管與稅損收割', () => {
  const inc = (foreignDividend: number, foreignRealized: number) => ({ domesticDividend: 0, nhi: 0, foreignDividend, foreignWithholding: 0, foreignRealized, domesticRealized: 0 });
  it('分級：安全／接近／超過 100 萬', () => {
    expect(overseasWatch(inc(100_000, 200_000), P(0), 0).level).toBe('safe');
    expect(overseasWatch(inc(100_000, 650_000), P(0), 0).level).toBe('near');
    expect(overseasWatch(inc(100_000, 1_200_000), P(0), 0).level).toBe('over');
  });
  it('超過門檻且有未實現虧損：實現後降到門檻以下 → 建議並說明風險', () => {
    const w = overseasWatch(inc(100_000, 1_050_000), P(0), 300_000);
    expect(w.level).toBe('over');
    expect(w.harvest).toMatchObject({ dropsBelowThreshold: true, newIncome: 850_000 });
    const h = overseasAdvice(w).headline;
    expect(h).toContain('未實現虧損');
    expect(h).toContain('是否划算請自行評估');
  });
  it('虧損不夠多：還是會超過門檻（照實說）', () => {
    const w = overseasWatch(inc(0, 1_500_000), P(0), 100_000);
    expect(w.harvest?.dropsBelowThreshold).toBe(false);
    expect(overseasAdvice(w).headline).toContain('還是會超過門檻');
  });
});

describe('資料層：即將除息事件', () => {
  const today = todayKey();
  beforeEach(async () => {
    await db.delete(); await db.open();
    useSettings.setState({ ...DEFAULT_SETTINGS, tax: { netIncome: 500_000 } } as never);
    await db.stocks.add({ id: 's1', market: 'TWSE', symbol: '00878', name: '國泰永續高股息', currency: 'TWD', assetType: 'etf', lotSize: 1000, createdAt: 1, updatedAt: 1 } as never);
    await db.stock_trades.add({ id: 't1', stockId: 's1', accountId: 'a', type: 'buy', date: addDays(today, -400), ts: 1, sharesDec: '15000', priceDec: '20', feeMinor: 0, taxMinor: 0, createdAt: 1, updatedAt: 1 } as never);
    await db.price_cache.put({ stockId: 's1', priceDec: '22', prevCloseDec: '22', changeDec: '0', changePctDec: '0', updatedAt: Date.now() } as never);
  });

  it('已公告的除息：算出配息、二代健保與建議；不在持股內的不列', async () => {
    await db.dividends.add({ id: 'd1', stockId: 's1', accountId: 'a', kind: 'cash', status: 'announced', exDate: addDays(today, 5), payDate: addDays(today, 25), perShareDec: '1.4', sharesHeldDec: '15000', grossMinor: 0, withholdingTaxMinor: 0, nhiSupplementMinor: 0, feeMinor: 0, netMinor: 0, currency: 'TWD', createdAt: 1, updatedAt: 1 } as never);
    const plan = await loadTaxPlan(today);
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0].event).toMatchObject({ symbol: '00878', source: 'announced', shares: 15000, gross: 21000 });
    expect(plan.events[0].nhi).toBe(443);
    expect(plan.events[0].recommendation).toBe('join');
  });

  it('沒有公告：依去年同期的配息推估（標示為推估）', async () => {
    await db.dividends.add({ id: 'd0', stockId: 's1', accountId: 'a', kind: 'cash', status: 'paid', exDate: addDays(today, -365 + 10), payDate: addDays(today, -365 + 30), perShareDec: '0.4', sharesHeldDec: '15000', grossMinor: 600000, withholdingTaxMinor: 0, nhiSupplementMinor: 0, feeMinor: 0, netMinor: 600000, currency: 'TWD', createdAt: 1, updatedAt: 1 } as never);
    const plan = await loadTaxPlan(today);
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0].event.source).toBe('estimated');
    expect(plan.events[0].event.gross).toBe(6000);
    expect(plan.events[0].nhi).toBe(0);
  });

  it('除息前提醒：7 天內且會被扣二代健保的，只通知一次', async () => {
    await db.dividends.add({ id: 'd1', stockId: 's1', accountId: 'a', kind: 'cash', status: 'announced', exDate: addDays(today, 3), payDate: addDays(today, 20), perShareDec: '1.4', sharesHeldDec: '15000', grossMinor: 0, withholdingTaxMinor: 0, nhiSupplementMinor: 0, feeMinor: 0, netMinor: 0, currency: 'TWD', createdAt: 1, updatedAt: 1 } as never);
    expect(await notifyUpcomingDividends()).toBe(1);
    const r = await db.reminders.toArray();
    expect(r).toHaveLength(1);
    expect(r[0].body).toContain('二代健保 443 元');
    await notifyUpcomingDividends(); // 同一事件不會重複通知
    expect(await db.reminders.count()).toBe(1);
  });

  it('今年已除息、還沒發放的股利也算進同年基準（不會高估剩餘的 8.5% 抵減額度）', async () => {
    // 已除息（exDate 在過去）但發放日在未來、狀態仍是 announced：不在「未來事件」裡，但同年度已確定會領到
    await db.dividends.add({ id: 'dx', stockId: 's1', accountId: 'a', kind: 'cash', status: 'announced', exDate: addDays(today, -3), payDate: addDays(today, 10), perShareDec: '2', sharesHeldDec: '15000', grossMinor: 0, withholdingTaxMinor: 0, nhiSupplementMinor: 0, feeMinor: 0, netMinor: 0, currency: 'TWD', createdAt: 1, updatedAt: 1 } as never);
    await db.dividends.add({ id: 'dn', stockId: 's1', accountId: 'a', kind: 'cash', status: 'announced', exDate: addDays(today, 5), payDate: addDays(today, 25), perShareDec: '1.4', sharesHeldDec: '15000', grossMinor: 0, withholdingTaxMinor: 0, nhiSupplementMinor: 0, feeMinor: 0, netMinor: 0, currency: 'TWD', createdAt: 1, updatedAt: 1 } as never);
    const plan = await loadTaxPlan(today);
    expect(plan.events).toHaveLength(1); // 只有未來那筆是事件
    // 基準 ＝ 已除息未發放的 30,000；抵減已用掉 round(30,000 × 8.5%) = 2,550，剩下 80,000 − 2,550
    expect(plan.events[0].creditRemainingBefore).toBe(80_000 - 2_550);
  });
});

describe('給問 AI 的投資與稅務統計', () => {
  it('只有整數元合計、股票代號與日期；沒有持股也沒有事件時不附', async () => {
    const { investTaxSummary } = await import('@/services/taxplan');
    await db.delete(); await db.open();
    useSettings.setState({ ...DEFAULT_SETTINGS, tax: { netIncome: 500_000 } } as never);
    expect(await investTaxSummary()).toBeNull();
    const today = todayKey();
    await db.stocks.add({ id: 's1', market: 'TWSE', symbol: '00878', name: '國泰永續高股息', currency: 'TWD', assetType: 'etf', lotSize: 1000, createdAt: 1, updatedAt: 1 } as never);
    await db.stock_trades.add({ id: 't1', stockId: 's1', accountId: 'a', type: 'buy', date: addDays(today, -400), ts: 1, sharesDec: '15000', priceDec: '20', feeMinor: 0, taxMinor: 0, createdAt: 1, updatedAt: 1 } as never);
    await db.price_cache.put({ stockId: 's1', priceDec: '22', prevCloseDec: '22', changeDec: '0', changePctDec: '0', updatedAt: Date.now() } as never);
    await db.dividends.add({ id: 'd1', stockId: 's1', accountId: 'a', kind: 'cash', status: 'announced', exDate: addDays(today, 5), payDate: addDays(today, 25), perShareDec: '1.4', sharesHeldDec: '15000', grossMinor: 0, withholdingTaxMinor: 0, nhiSupplementMinor: 0, feeMinor: 0, netMinor: 0, currency: 'TWD', createdAt: 1, updatedAt: 1 } as never);
    const s = await investTaxSummary();
    expect(s?.upcomingDividends).toEqual([{ symbol: '00878', exDate: addDays(today, 5), gross: 21000, nhi: 443, recommendation: 'join' }]);
    expect(s?.holdingsValue).toBe(330_000); // 15,000 股 × 22
    expect(JSON.stringify(s)).not.toMatch(/shares|cost|國泰/); // 不含股數、成本、名稱
  });
});

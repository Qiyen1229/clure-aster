/**
 * 投資計算驗算範例（手算可驗證）：
 * 台股：買 1000 股 @100（手續費 142）、買 1000 股 @110（手續費 156）、賣 1000 股 @120（手續費 171、證交稅 360）
 *  - 總成本 = 100,142 + 110,156 = 210,298；平均成本 = 105.149
 *  - 賣出淨收入 = 120,000 − 171 − 360 = 119,469
 *  - 加權平均：沖銷成本 105,149 → 已實現 14,320；剩餘成本 105,149
 *  - FIFO：沖銷第一批 100,142 → 已實現 19,327；剩餘成本 110,156
 */
import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { computePosition, valuate, yields } from '@/domain/invest/position';
import { DEFAULT_TW_FEES, isOddLot, twFee, twSellTax, twTaxRate } from '@/domain/invest/fees-tw';
import { xirr } from '@/domain/invest/xirr';
import { marketState, usHolidays } from '@/domain/invest/market-hours';
import type { StockTrade } from '@/db/types';

let seq = 0;
const tr = (type: StockTrade['type'], date: string, shares: string, price: string, fee = 0, tax = 0, fx = '1') =>
  ({ id: `t${++seq}`, type, date, ts: seq, sharesDec: shares, priceDec: price, feeMinor: fee, taxMinor: tax, fxRateDec: fx });

describe('台股手續費與證交稅', () => {
  it('手續費無條件捨去到元，最低 20 元／零股 1 元', () => {
    expect(twFee('100', '1000')).toBe(14200);
    expect(twFee('110', '1000')).toBe(15600);
    expect(twFee('120', '1000')).toBe(17100);
    expect(twFee('10', '1000')).toBe(2000); // 14.25 → 最低 20
    expect(twFee('100', '10')).toBe(100); // 零股 1.425 → 1
    expect(twFee('100', '1000', { ...DEFAULT_TW_FEES, discountDec: '0.6' })).toBe(8500); // 142.5×0.6=85.5→85
    expect(twFee('100', '10', { ...DEFAULT_TW_FEES, discountDec: '0.28' })).toBe(100); // 0.399→0，最低 1
  });
  it('證交稅：股票 0.3%、ETF 0.1%、債券 ETF 0', () => {
    expect(twSellTax('120', '1000', twTaxRate('stock'))).toBe(36000);
    expect(twSellTax('50', '1000', twTaxRate('etf'))).toBe(5000);
    expect(twSellTax('35.55', '333', twTaxRate('etf'))).toBe(1100); // 11838.15×0.001=11.8→11
    expect(twSellTax('40', '1000', twTaxRate('bond_etf'))).toBe(0);
  });
  it('零股判斷', () => {
    expect(isOddLot('1000')).toBe(false);
    expect(isOddLot('1500')).toBe(true);
  });
});

describe('持倉：加權平均與 FIFO', () => {
  const trades = [
    tr('buy', '2026-01-02', '1000', '100', 14200),
    tr('buy', '2026-02-02', '1000', '110', 15600),
    tr('sell', '2026-03-02', '1000', '120', 17100, 36000),
  ];
  it('加權平均', () => {
    const p = computePosition(trades, 'avg');
    expect(p.shares.toString()).toBe('1000');
    expect(p.realized[0].proceedsMinor).toBe(11946900);
    expect(p.realizedMinor).toBe(1432000);
    expect(p.costMinor).toBe(10514900);
    expect(p.avgCost.toString()).toBe('105.149');
  });
  it('FIFO', () => {
    const p = computePosition(trades, 'fifo');
    expect(p.realizedMinor).toBe(1932700);
    expect(p.costMinor).toBe(11015600);
    expect(p.avgCost.toString()).toBe('110.156');
  });
  it('兩種方法的「已實現 + 剩餘成本」總和一致', () => {
    const a = computePosition(trades, 'avg');
    const f = computePosition(trades, 'fifo');
    expect(a.realizedMinor + -a.costMinor).toBe(f.realizedMinor + -f.costMinor);
  });
  it('配股使平均成本下降、分割倍數', () => {
    const p = computePosition([tr('buy', '2026-01-01', '1000', '100'), tr('stock_dividend', '2026-07-01', '100', '0')], 'avg');
    expect(p.shares.toString()).toBe('1100');
    expect(p.costMinor).toBe(10000000);
    expect(p.avgCost.toFixed(4)).toBe('90.9091');
    const s = computePosition([tr('buy', '2026-01-01', '10', '400'), tr('split', '2026-06-01', '4', '0')], 'avg');
    expect(s.shares.toString()).toBe('40');
    expect(s.avgCost.toString()).toBe('100');
  });
  it('全部賣出後持股歸零', () => {
    const p = computePosition([tr('buy', '2026-01-01', '100', '10'), tr('sell', '2026-02-01', '100', '12')], 'avg');
    expect(p.shares.isZero()).toBe(true);
    expect(p.costMinor).toBe(0);
    expect(p.realizedMinor).toBe(20000);
  });
  it('超賣只沖銷持有部分', () => {
    const p = computePosition([tr('buy', '2026-01-01', '100', '10'), tr('sell', '2026-02-01', '150', '12')], 'fifo');
    expect(p.realized[0].shares.toString()).toBe('100');
  });
});

describe('估值與匯差拆分', () => {
  it('美股：10 股 @100 USD（匯率 30）→ 現價 120、匯率 32', () => {
    const p = computePosition([tr('buy', '2026-01-01', '10', '100', 0, 0, '30')], 'avg');
    const v = valuate(p, '120', '118', '32');
    expect(v.marketValueMinor).toBe(120000); // US$1,200
    expect(v.unrealizedMinor).toBe(20000); // US$200
    expect(v.unrealizedPct).toBeCloseTo(20);
    expect(v.todayChangeMinor).toBe(2000); // 10 × 2
    expect(v.marketValueBaseMinor).toBe(3840000); // NT$38,400
    expect(v.unrealizedBaseMinor).toBe(840000); // NT$8,400
    expect(v.pricePnlBaseMinor).toBe(640000); // 200 × 32
    expect(v.fxPnlBaseMinor).toBe(200000); // 1000 × (32 − 30)
    expect(v.pricePnlBaseMinor + v.fxPnlBaseMinor).toBe(v.unrealizedBaseMinor);
  });
  it('殖利率', () => {
    const y = yields('5', new Decimal('100'), '125');
    expect(y.costYieldPct).toBe(5);
    expect(y.priceYieldPct).toBe(4);
  });
});

describe('XIRR', () => {
  it('Excel 官方範例 = 37.34%', () => {
    const r = xirr([
      { date: '2008-01-01', amount: -10000 }, { date: '2008-03-01', amount: 2750 },
      { date: '2008-10-30', amount: 4250 }, { date: '2009-02-15', amount: 3250 }, { date: '2009-04-01', amount: 2750 },
    ]);
    expect(r).toBeCloseTo(0.373362535, 6);
  });
  it('一年後 +10% → 10%', () => {
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }])).toBeCloseTo(0.1, 6);
  });
  it('虧損與無效輸入', () => {
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 500 }])).toBeCloseTo(-0.5, 6);
    expect(xirr([{ date: '2025-01-01', amount: -1000 }])).toBeNull();
    expect(xirr([{ date: '2025-01-01', amount: 1000 }, { date: '2025-06-01', amount: 1000 }])).toBeNull();
  });
});

describe('市場狀態', () => {
  it('台股', () => {
    expect(marketState('TWSE', new Date('2026-10-12T02:00:00Z'))).toBe('open'); // 週一 10:00
    expect(marketState('TWSE', new Date('2026-10-12T00:45:00Z'))).toBe('pre'); // 08:45
    expect(marketState('TWSE', new Date('2026-10-12T06:00:00Z'))).toBe('closed'); // 14:00
    expect(marketState('TWSE', new Date('2026-10-09T02:00:00Z'))).toBe('holiday'); // 國慶補假
    expect(marketState('TPEX', new Date('2026-10-10T02:00:00Z'))).toBe('holiday'); // 週六
  });
  it('美股假日規則', () => {
    const h = usHolidays(2026);
    expect(h.has('2026-11-26')).toBe(true); // 感恩節
    expect(h.has('2026-04-03')).toBe(true); // 耶穌受難日
    expect(h.has('2026-07-03')).toBe(true); // 7/4 週六 → 7/3 補
    expect(marketState('US', new Date('2026-10-12T15:00:00Z'))).toBe('open'); // 11:00 ET
  });
});

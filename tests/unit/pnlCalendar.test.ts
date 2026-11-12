import { describe, expect, it } from 'vitest';
import type { PriceHistory, Stock, StockTrade } from '@/db/types';
import { computePnlCalendar, formatPnlCompact, formatPnlPct } from '@/domain/invest/pnlCalendar';

describe('computePnlCalendar 盈虧日曆純計算領域', () => {
  const stockTwd: Stock = {
    id: 's-2330',
    market: 'TWSE',
    symbol: '2330',
    name: '台積電',
    currency: 'TWD',
    assetType: 'stock',
    lotSize: 1000,
    createdAt: 1000,
    updatedAt: 1000,
  };

  const stockUsd: Stock = {
    id: 's-aapl',
    market: 'US',
    symbol: 'AAPL',
    name: '蘋果',
    currency: 'USD',
    assetType: 'stock',
    lotSize: 1,
    createdAt: 1000,
    updatedAt: 1000,
  };

  it('長期持有者：昨日買進、今日無賣出但上漲，應計入今日未實現浮動損益', () => {
    // 2026-09-01 買進 1,000 股台積電 @ 900
    const trades: StockTrade[] = [
      {
        id: 't-1',
        stockId: 's-2330',
        accountId: 'acc-1',
        type: 'buy',
        date: '2026-09-01',
        ts: 1000,
        sharesDec: '1000',
        priceDec: '900',
        feeMinor: 10000, // 100 元
        taxMinor: 0,
        fxRateDec: '1',
        isDCA: false,
        syncToLedger: false,
        note: '',
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];

    // 2026-09-02 台積電由 900 漲到 920（漲 20 元）
    const histories: PriceHistory[] = [
      { stockId: 's-2330', date: '2026-09-01', closeDec: '900' },
      { stockId: 's-2330', date: '2026-09-02', closeDec: '920' },
    ];

    const res = computePnlCalendar({
      stocks: [stockTwd],
      trades,
      priceCaches: [],
      priceHistories: histories,
      startDate: '2026-09-01',
      endDate: '2026-09-03',
      today: '2026-09-10',
    });

    const day2 = res.days.get('2026-09-02');
    expect(day2).toBeDefined();
    expect(day2?.hasActivity).toBe(true);
    expect(day2?.currencies.length).toBe(1);

    const twd = day2?.currencies[0];
    expect(twd?.currency).toBe('TWD');
    // 1000 股 × 20 元 = 20,000 元 = 2,000,000 minor
    expect(twd?.pnlMinor).toBe(2000000);
    expect(twd?.pnlPct).toBeGreaterThan(2); // ~2.22%
  });

  it('當沖或賣出日：正確計算已實現損益', () => {
    // 2026-09-01 買進 1,000 股 @ 900
    // 2026-09-05 賣出 1,000 股 @ 950（費 100, 稅 285）
    const trades: StockTrade[] = [
      {
        id: 't-1',
        stockId: 's-2330',
        accountId: 'acc-1',
        type: 'buy',
        date: '2026-09-01',
        ts: 1000,
        sharesDec: '1000',
        priceDec: '900',
        feeMinor: 10000,
        taxMinor: 0,
        fxRateDec: '1',
        isDCA: false,
        syncToLedger: false,
        note: '',
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 't-2',
        stockId: 's-2330',
        accountId: 'acc-1',
        type: 'sell',
        date: '2026-09-05',
        ts: 2000,
        sharesDec: '1000',
        priceDec: '950',
        feeMinor: 10000,
        taxMinor: 28500,
        fxRateDec: '1',
        isDCA: false,
        syncToLedger: false,
        note: '',
        createdAt: 2000,
        updatedAt: 2000,
      },
    ];

    const res = computePnlCalendar({
      stocks: [stockTwd],
      trades,
      priceCaches: [],
      priceHistories: [],
      startDate: '2026-09-01',
      endDate: '2026-09-05',
      today: '2026-09-10',
    });

    const day5 = res.days.get('2026-09-05');
    expect(day5?.hasTrade).toBe(true);
    expect(day5?.hasActivity).toBe(true);

    const twd = day5?.currencies[0];
    expect(twd?.currency).toBe('TWD');
    // 毛利: (950 - 900) * 1000 = 50,000 元
    // 扣除買費 100 + 賣費 100 + 賣稅 285 = 485 元
    // 淨損益 = 49,515 元 = 4,951,500 minor
    expect(twd?.pnlMinor).toBe(4951500);
  });

  it('多幣別（台股 TWD + 美股 USD）同一天分開計算兩行', () => {
    // 2026-09-01 同時持有 2330 與 AAPL
    const trades: StockTrade[] = [
      {
        id: 't-1',
        stockId: 's-2330',
        accountId: 'acc-1',
        type: 'buy',
        date: '2026-09-01',
        ts: 1000,
        sharesDec: '1000',
        priceDec: '900',
        feeMinor: 10000,
        taxMinor: 0,
        fxRateDec: '1',
        isDCA: false,
        syncToLedger: false,
        note: '',
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 't-2',
        stockId: 's-aapl',
        accountId: 'acc-2',
        type: 'buy',
        date: '2026-09-01',
        ts: 1000,
        sharesDec: '10',
        priceDec: '200',
        feeMinor: 100, // 1 USD
        taxMinor: 0,
        fxRateDec: '32',
        isDCA: false,
        syncToLedger: false,
        note: '',
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];

    // 2026-09-02: 2330 漲 10 元 (+10,000 TWD), AAPL 漲 5 元 (+50 USD)
    const histories: PriceHistory[] = [
      { stockId: 's-2330', date: '2026-09-01', closeDec: '900' },
      { stockId: 's-2330', date: '2026-09-02', closeDec: '910' },
      { stockId: 's-aapl', date: '2026-09-01', closeDec: '200' },
      { stockId: 's-aapl', date: '2026-09-02', closeDec: '205' },
    ];

    const res = computePnlCalendar({
      stocks: [stockTwd, stockUsd],
      trades,
      priceCaches: [],
      priceHistories: histories,
      startDate: '2026-09-01',
      endDate: '2026-09-03',
      today: '2026-09-10',
    });

    const day2 = res.days.get('2026-09-02');
    expect(day2?.currencies.length).toBe(2);

    const twd = day2?.currencies.find((c) => c.currency === 'TWD');
    const usd = day2?.currencies.find((c) => c.currency === 'USD');

    expect(twd?.pnlMinor).toBe(1000000); // +10,000 元
    expect(usd?.pnlMinor).toBe(5000); // +50 USD (5000 minor)
  });

  it('週末與無交易無開盤的日子自動留白（hasActivity = false）', () => {
    const trades: StockTrade[] = [
      {
        id: 't-1',
        stockId: 's-2330',
        accountId: 'acc-1',
        type: 'buy',
        date: '2026-09-01',
        ts: 1000,
        sharesDec: '1000',
        priceDec: '900',
        feeMinor: 10000,
        taxMinor: 0,
        fxRateDec: '1',
        isDCA: false,
        syncToLedger: false,
        note: '',
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];

    // 2026-09-06 (週日) 無價格資料
    const res = computePnlCalendar({
      stocks: [stockTwd],
      trades,
      priceCaches: [],
      priceHistories: [],
      startDate: '2026-09-06',
      endDate: '2026-09-06',
      today: '2026-09-10',
    });

    const daySun = res.days.get('2026-09-06');
    expect(daySun?.hasActivity).toBe(false);
    expect(daySun?.currencies.length).toBe(0);
  });

  it('formatPnlCompact 與 formatPnlPct 格式化測試', () => {
    expect(formatPnlCompact({ currency: 'TWD', pnlMinor: 125000, baseValueMinor: 1000000, pnlPct: 12.5 })).toBe('$+1,250');
    expect(formatPnlCompact({ currency: 'TWD', pnlMinor: -85000, baseValueMinor: 1000000, pnlPct: -8.5 })).toBe('$-850');
    expect(formatPnlCompact({ currency: 'TWD', pnlMinor: 125000, baseValueMinor: 1000000, pnlPct: 12.5 }, true)).toBe('NT$+1,250');
    expect(formatPnlCompact({ currency: 'USD', pnlMinor: 4520, baseValueMinor: 100000, pnlPct: 4.52 }, true)).toBe('US$+45.2');
    expect(formatPnlPct(3.24)).toBe('+3.2%');
    expect(formatPnlPct(-1.87)).toBe('-1.9%');
  });
});

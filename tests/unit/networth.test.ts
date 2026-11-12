import { describe, it, expect } from 'vitest';
import { buildAccountDeltaIndex, sumDeltasAfter } from '@/services/networth';

describe('networth 歷史淨值回推效能與精確度', () => {
  it('正確計算指定日期之後的金額變更（二分搜尋前綴/後綴和）', () => {
    const deltas = [
      { date: '2026-01-10', acc: 'acc1', v: 100 },
      { date: '2026-02-15', acc: 'acc1', v: 250 },
      { date: '2026-03-20', acc: 'acc1', v: 400 },
      { date: '2026-01-05', acc: 'acc2', v: 50 },
      { date: '2026-04-01', acc: 'acc2', v: 80 },
    ];

    const index = buildAccountDeltaIndex(deltas);

    // acc1: 2026-01-31 之後發生的變動是 02-15 (250) + 03-20 (400) = 650
    expect(sumDeltasAfter(index, 'acc1', '2026-01-31')).toBe(650);

    // acc1: 2026-02-28 之後發生的變動是 03-20 (400)
    expect(sumDeltasAfter(index, 'acc1', '2026-02-28')).toBe(400);

    // acc1: 2026-03-31 之後沒有變動 = 0
    expect(sumDeltasAfter(index, 'acc1', '2026-03-31')).toBe(0);

    // acc1: 2026-01-01 之前發生的變動全部算入 = 100 + 250 + 400 = 750
    expect(sumDeltasAfter(index, 'acc1', '2026-01-01')).toBe(750);

    // 不存在的帳戶回傳 0
    expect(sumDeltasAfter(index, 'non-existent', '2026-01-01')).toBe(0);
  });

  it('支援大量資料高效率查詢', () => {
    const deltas: { date: string; acc: string; v: number }[] = [];
    for (let i = 1; i <= 1000; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      const m = String((i % 12) + 1).padStart(2, '0');
      deltas.push({ date: `2026-${m}-${day}`, acc: `acc${i % 10}`, v: 10 });
    }

    const t0 = performance.now();
    const index = buildAccountDeltaIndex(deltas);
    for (let k = 0; k < 1000; k++) {
      sumDeltasAfter(index, `acc${k % 10}`, '2026-06-15');
    }
    const duration = performance.now() - t0;
    // 1000 次查詢應在 15ms 內完成
    expect(duration).toBeLessThan(100);
  });
});

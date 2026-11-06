import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { clearCalc, pushCalc, setCalcKeep } from '@/services/calcHistory';

const history = async () => ((await db.meta.get('calc.history'))?.value ?? []) as { expr: string; result: string }[];

describe('計算機記錄', () => {
  beforeEach(async () => { await db.meta.delete('calc.history'); await db.meta.delete('calc.keep'); });

  it('預設保存最近 10 筆，最新的排最前', async () => {
    for (let i = 1; i <= 12; i++) await pushCalc(`${i}+1`, String(i + 1));
    const h = await history();
    expect(h).toHaveLength(10);
    expect(h[0]).toMatchObject({ expr: '12+1', result: '13' });
    expect(h[9]).toMatchObject({ expr: '3+1', result: '4' });
  });

  it('和最前面一筆完全相同就不重複記', async () => {
    await pushCalc('1200 ＋10%', '1320');
    await pushCalc('1200 ＋10%', '1320');
    expect(await history()).toHaveLength(1);
  });

  it('可改保存筆數；變少時立刻裁掉多的；清除全部', async () => {
    for (let i = 1; i <= 8; i++) await pushCalc(`${i}×2`, String(i * 2));
    await setCalcKeep(5);
    expect(await history()).toHaveLength(5);
    await pushCalc('9×2', '18');
    expect((await history())[0].result).toBe('18');
    expect(await history()).toHaveLength(5);
    await clearCalc();
    expect(await history()).toEqual([]);
  });
});

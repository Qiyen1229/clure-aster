import { describe, expect, it } from 'vitest';
import { forecastAll, forecastBudget, type BudgetLite } from '@/domain/budgetwarn';

const fmt = (m: number) => `$${Math.round(m / 100)}`;
const period = { start: '2026-10-01', end: '2026-10-31' };
const b = (o: Partial<BudgetLite>): BudgetLite => ({ id: 'b1', name: '餐飲', limit: 1000000, spent: 0, period, today: '2026-10-10', projected: 0, ...o });

describe('預算預警', () => {
  it('照目前速度會超支（預計 110%）→ early，算出預計用完的日子與每天最多能花多少', () => {
    // 10 天花了 $4000（每天 $400），額度 $10000：剩 $6000，再 25 天… 預計 $12400？ 這裡直接給預計值
    const w = forecastBudget(b({ spent: 400000, projected: 1100000 }), fmt)!;
    expect(w.level).toBe('early');
    expect(w.exhaustDate).toBe('2026-10-25'); // 6000/400 = 15 天後
    expect(w.dailyCap).toBe(28571); // 600000 / 21 天（元：285.71 → 以分計 28571）
    expect(w.why).toContain('預計期末會花到 $11000');
    expect(w.why).toContain('大約 10/25');
    expect(w.tip).toContain('$286');
  });
  it('預計沒超過額度 → 不提醒', () => {
    expect(forecastBudget(b({ spent: 300000, projected: 900000 }), fmt)).toBeNull();
  });
  it('已用 90% 以上、或預計超過 120% → critical', () => {
    expect(forecastBudget(b({ spent: 920000, projected: 1000000 }), fmt)!.level).toBe('critical');
    expect(forecastBudget(b({ spent: 500000, projected: 1300000 }), fmt)!.level).toBe('critical');
  });
  it('已超支 → over，說明超出多少與還剩幾天', () => {
    const w = forecastBudget(b({ spent: 1200000, projected: 1500000 }), fmt)!;
    expect(w.level).toBe('over');
    expect(w.title).toContain('超支 $2000');
    expect(w.why).toContain('20%');
    expect(w.why).toContain('21 天');
    expect(w.dailyCap).toBe(0);
  });
  it('期間剛開始（不到 3 天）或還沒花錢 → 預測不準，不打擾', () => {
    expect(forecastBudget(b({ today: '2026-10-02', spent: 500000, projected: 1500000 }), fmt)).toBeNull();
    expect(forecastBudget(b({ spent: 0, projected: 0 }), fmt)).toBeNull();
  });
  it('今天不在預算期間內，或額度為 0 → 不提醒', () => {
    expect(forecastBudget(b({ today: '2026-11-03', spent: 500000, projected: 1500000 }), fmt)).toBeNull();
    expect(forecastBudget(b({ limit: 0, spent: 100 }), fmt)).toBeNull();
  });
  it('最後一天不再預測（只剩已超支的訊息）', () => {
    expect(forecastBudget(b({ today: '2026-10-31', spent: 900000, projected: 900000 }), fmt)).toBeNull();
  });
  it('id 同一預算、同一期、同一等級固定不變（通知只會發一次）', () => {
    const w1 = forecastBudget(b({ spent: 400000, projected: 1100000 }), fmt)!;
    const w2 = forecastBudget(b({ spent: 410000, projected: 1120000, today: '2026-10-11' }), fmt)!;
    expect(w1.id).toBe(w2.id);
    expect(w1.id).toBe('bw:b1:2026-10-01:early');
  });
  it('多個預算依嚴重程度排序', () => {
    const list = forecastAll([
      b({ id: 'a', name: '交通', spent: 400000, projected: 1100000 }),
      b({ id: 'c', name: '娛樂', spent: 1300000, projected: 1600000 }),
      b({ id: 'd', name: '飲食', spent: 920000, projected: 1000000 }),
    ], fmt);
    expect(list.map((x) => x.level)).toEqual(['over', 'critical', 'early']);
  });
});

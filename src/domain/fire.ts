/**
 * 財務自由（FIRE）試算：蒙地卡羅模擬。
 *
 * 每次模擬以常態分布抽樣每年報酬率（期望值 expectedReturn、標準差 volatility），通膨固定：
 * - 累積期：資產 ×（1＋報酬）＋ 每年儲蓄（隨通膨成長）
 * - 財務自由門檻：當年生活費（隨通膨成長）÷ 安全提領率
 * - 退休期（retireAge 起）：每年提領生活費，資產撐到 endAge 視為成功
 * 回傳各年齡「已達財務自由」的機率、達成年齡中位數、資產分位數曲線與退休成功率。
 * 純函式（可指定亂數種子），方便測試；所有金額以主幣別「主單位」計。
 */

export interface FireInput {
  currentAge: number;
  retireAge: number;
  endAge: number;
  netWorth: number;
  annualExpense: number;
  annualSaving: number;
  /** 年化報酬率（例如 0.06） */
  expectedReturn: number;
  volatility: number;
  inflation: number;
  /** 安全提領率（例如 0.04） */
  withdrawalRate: number;
  runs?: number;
  seed?: number;
}

export interface FireResult {
  ages: number[];
  /** 各年齡已達財務自由的機率（0–1） */
  fiProbability: number[];
  /** 達成財務自由年齡的中位數（沒有過半數達成則為 null） */
  medianFiAge: number | null;
  /** 資產分位數（P10／P50／P90），對應 ages */
  p10: number[];
  p50: number[];
  p90: number[];
  /** 財務自由門檻（隨通膨），對應 ages */
  target: number[];
  /** 依 retireAge 退休、資產撐到 endAge 的機率 */
  retireSuccess: number;
  /** 不考慮波動的確定性試算：達成年齡 */
  deterministicFiAge: number | null;
}

/** Mulberry32：小而快的可重現亂數 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number): number {
  // Box–Muller
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

export function simulateFire(input: FireInput): FireResult {
  const runs = Math.max(50, Math.min(5000, input.runs ?? 1000));
  const years = Math.max(1, Math.round(input.endAge - input.currentAge));
  const ages = Array.from({ length: years + 1 }, (_, i) => input.currentAge + i);
  const target = ages.map((_, y) => (input.annualExpense * (1 + input.inflation) ** y) / Math.max(0.005, input.withdrawalRate));
  const rand = rng(input.seed ?? 42);
  const reachedBy = new Array(ages.length).fill(0);
  const wealth: number[][] = ages.map(() => []);
  const fiAges: number[] = [];
  let retireOk = 0;
  const retireIdx = Math.max(0, Math.min(years, Math.round(input.retireAge - input.currentAge)));

  for (let r = 0; r < runs; r++) {
    let w = input.netWorth;      // 一直工作、持續儲蓄（用來看「何時」達成）
    let rw = input.netWorth;     // 依 retireAge 退休的路徑
    let fiAt = -1;
    let alive = true;
    for (let y = 0; y <= years; y++) {
      if (y > 0) {
        const ret = input.expectedReturn + input.volatility * normal(rand);
        const infl = (1 + input.inflation) ** (y - 1);
        w = w * (1 + ret) + input.annualSaving * infl;
        if (y <= retireIdx) rw = rw * (1 + ret) + input.annualSaving * infl;
        else rw = rw * (1 + ret) - input.annualExpense * infl;
        if (rw <= 0) alive = false;
      }
      if (fiAt < 0 && w >= target[y]) fiAt = y;
      if (fiAt >= 0) reachedBy[y]++;
      wealth[y].push(w);
    }
    if (fiAt >= 0) fiAges.push(ages[fiAt]);
    if (alive) retireOk++;
  }
  const sortedW = wealth.map((list) => list.sort((a, b) => a - b));
  fiAges.sort((a, b) => a - b);
  // 確定性：每年都拿到期望報酬
  let dw = input.netWorth;
  let detAge: number | null = dw >= target[0] ? ages[0] : null;
  for (let y = 1; y <= years && detAge === null; y++) {
    dw = dw * (1 + input.expectedReturn) + input.annualSaving * (1 + input.inflation) ** (y - 1);
    if (dw >= target[y]) detAge = ages[y];
  }
  return {
    ages,
    fiProbability: reachedBy.map((n) => n / runs),
    medianFiAge: fiAges.length >= runs / 2 ? fiAges[Math.floor(runs / 2)] : null,
    p10: sortedW.map((l) => quantile(l, 0.1)),
    p50: sortedW.map((l) => quantile(l, 0.5)),
    p90: sortedW.map((l) => quantile(l, 0.9)),
    target,
    retireSuccess: retireOk / runs,
    deterministicFiAge: detAge,
  };
}

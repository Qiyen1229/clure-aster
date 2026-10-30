/** 偵測用的小型統計函式（中位數、分位數、MAD）。獨立成檔，pricing.ts 與 anomaly.ts 才不會互相引用。 */
export const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const quantile = (a: number[], q: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export const mad = (a: number[], med = median(a)) => median(a.map((v) => Math.abs(v - med)));

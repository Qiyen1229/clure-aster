/**
 * XIRR（不定期現金流年化報酬率），與 Excel XIRR 相同定義：
 *   Σ cf_i / (1 + r)^((d_i − d_0) / 365) = 0
 * 先用 Newton–Raphson，不收斂時改用二分法。投入為負、取回（含期末市值）為正。
 */
export interface CashFlow {
  date: string; // YYYY-MM-DD
  amount: number;
}

const DAY = 86400000;

function npv(rate: number, flows: { t: number; a: number }[]) {
  let v = 0;
  for (const f of flows) v += f.a / Math.pow(1 + rate, f.t);
  return v;
}
function dnpv(rate: number, flows: { t: number; a: number }[]) {
  let v = 0;
  for (const f of flows) v -= (f.t * f.a) / Math.pow(1 + rate, f.t + 1);
  return v;
}

/** 回傳年化報酬率（0.12 = 12%）；無法計算時回傳 null */
export function xirr(cashflows: CashFlow[], guess = 0.1): number | null {
  const cf = cashflows.filter((c) => c.amount !== 0);
  if (cf.length < 2 || !cf.some((c) => c.amount > 0) || !cf.some((c) => c.amount < 0)) return null;
  const t0 = Math.min(...cf.map((c) => Date.parse(c.date)));
  const flows = cf.map((c) => ({ t: (Date.parse(c.date) - t0) / DAY / 365, a: c.amount }));
  if (flows.every((f) => f.t === 0)) return null;

  let r = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(r, flows);
    const d = dnpv(r, flows);
    if (!isFinite(f) || !isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (next <= -0.999999) break;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }
  // 二分法備援
  let lo = -0.9999, hi = 10;
  let flo = npv(lo, flows), fhi = npv(hi, flows);
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid, flows);
    if (Math.abs(fm) < 1e-9 || hi - lo < 1e-12) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

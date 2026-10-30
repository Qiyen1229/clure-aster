/**
 * 阻尼彈簧（純函式）：玻璃透鏡跟著手指與慣性滑動用。
 * 以「角頻率 ω 與阻尼比 ζ」描述：ζ = 1 臨界阻尼（最快到位、不會彈過頭）；ζ < 1 會有一點回彈。
 * 使用半隱式 Euler 並把時間步長限制在 32ms 內，掉幀時也不會數值發散。
 */
export interface Spring1D { p: number; v: number; t: number }

export const makeSpring = (p = 0): Spring1D => ({ p, v: 0, t: p });

/** 前進 dtSec 秒；回傳是否仍在運動 */
export function stepSpring(s: Spring1D, omega: number, zeta: number, dtSec: number): boolean {
  const dt = Math.min(Math.max(dtSec, 0), 0.032);
  // 步長太大時拆成小步，數值更穩
  const n = Math.max(1, Math.ceil(dt / 0.008));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const a = omega * omega * (s.t - s.p) - 2 * zeta * omega * s.v;
    s.v += a * h;
    s.p += s.v * h;
  }
  if (Math.abs(s.t - s.p) < 0.15 && Math.abs(s.v) < 4) { s.p = s.t; s.v = 0; return false; }
  return true;
}

/** 依放開時的速度（px/s）推算慣性終點：手指甩得越快，會滑得越遠一點 */
export const projectEnd = (pos: number, velocity: number, seconds = 0.12) => pos + velocity * seconds;

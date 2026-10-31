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

/** 預先算好的彈簧軌跡：每 dt 秒一格的位置與速度；交給 WAAPI（合成器）播放，主執行緒忙碌時也不掉幀 */
export interface SpringTrack { pos: number[]; vel: number[]; dt: number; duration: number }

/** 從 from（初速 v0，px/s）彈到 to，回傳整段軌跡；最長 maxSec 秒，收斂後最後一格剛好等於 to */
export function sampleSpring(from: number, to: number, v0: number, omega: number, zeta: number, maxSec = 1.2, fps = 60): SpringTrack {
  const dt = 1 / fps;
  const s: Spring1D = { p: from, v: v0, t: to };
  const pos = [from];
  const vel = [v0];
  for (let i = 0; i < maxSec * fps; i++) {
    const moving = stepSpring(s, omega, zeta, dt);
    pos.push(s.p);
    vel.push(s.v);
    if (!moving) break;
  }
  return { pos, vel, dt, duration: (pos.length - 1) * dt };
}

/** 取軌跡在 tSec 秒時的位置與速度（線性內插）；超過終點就是終點 */
export function trackAt(tr: SpringTrack, tSec: number): { p: number; v: number } {
  const f = Math.max(0, tSec) / tr.dt;
  const i = Math.floor(f);
  if (i >= tr.pos.length - 1) return { p: tr.pos[tr.pos.length - 1], v: tr.vel[tr.vel.length - 1] };
  const k = f - i;
  return { p: tr.pos[i] + (tr.pos[i + 1] - tr.pos[i]) * k, v: tr.vel[i] + (tr.vel[i + 1] - tr.vel[i]) * k };
}

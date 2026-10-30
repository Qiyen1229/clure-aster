import { describe, expect, it } from 'vitest';
import { makeSpring, projectEnd, stepSpring } from '@/domain/spring';

const run = (s: ReturnType<typeof makeSpring>, omega: number, zeta: number, seconds: number, fps = 60) => {
  const trace: number[] = [];
  for (let i = 0; i < seconds * fps; i++) { stepSpring(s, omega, zeta, 1 / fps); trace.push(s.p); }
  return trace;
};

describe('透鏡彈簧', () => {
  it('臨界阻尼（ζ=1）：平滑到位、不會彈過頭', () => {
    const s = makeSpring(0); s.t = 300;
    const tr = run(s, 10, 1, 1.5);
    expect(Math.max(...tr)).toBeLessThanOrEqual(300.0001);
    expect(s.p).toBe(300); // 收斂後吸附目標
    expect(tr.every((v, i) => i === 0 || v >= tr[i - 1] - 1e-9)).toBe(true); // 單調前進
  });
  it('約 0.4 秒內走完 90% 以上，不會太快也不會拖太久', () => {
    const s = makeSpring(0); s.t = 100;
    const tr = run(s, 11, 1, 0.5);
    expect(tr[Math.round(0.1 * 60)]).toBeLessThan(40); // 前 0.1 秒不是瞬間跳過去
    expect(tr[Math.round(0.4 * 60)]).toBeGreaterThan(90);
  });
  it('帶著初速度會依慣性前進；ζ=1 不過頭，ζ<1 才有回彈', () => {
    const a = makeSpring(0); a.t = 100; a.v = 1200;
    expect(Math.max(...run(a, 10, 1, 1.5))).toBeLessThan(120);
    const b = makeSpring(0); b.t = 100;
    expect(Math.max(...run(b, 10, 0.5, 1.5))).toBeGreaterThan(100);
  });
  it('掉幀（大時間步長）也不會發散', () => {
    const s = makeSpring(0); s.t = 100;
    for (let i = 0; i < 30; i++) stepSpring(s, 40, 1, 0.5);
    expect(Number.isFinite(s.p)).toBe(true);
    expect(s.p).toBe(100);
  });
  it('慣性終點：往右甩得越快落點越右', () => {
    expect(projectEnd(100, 0)).toBe(100);
    expect(projectEnd(100, 1000)).toBeGreaterThan(projectEnd(100, 400));
    expect(projectEnd(100, -1000)).toBeLessThan(100);
  });
});

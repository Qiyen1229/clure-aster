import { describe, expect, it } from 'vitest';
import { makeSpring, projectEnd, sampleSpring, stepSpring, trackAt } from '@/domain/spring';

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

describe('彈簧軌跡（交給合成器播放）', () => {
  it('起點與終點正確、會收斂', () => {
    const tr = sampleSpring(10, 210, 0, 16, 0.6);
    expect(tr.pos[0]).toBe(10);
    expect(tr.pos[tr.pos.length - 1]).toBe(210);
    expect(tr.duration).toBeLessThan(1);
  });
  it('Q 彈：欠阻尼會過衝一點再回來，過衝幅度適中（約 3%～15%）', () => {
    const tr = sampleSpring(0, 100, 0, 16, 0.6);
    const peak = Math.max(...tr.pos);
    expect(peak).toBeGreaterThan(103);
    expect(peak).toBeLessThan(115);
  });
  it('臨界阻尼不過衝', () => {
    expect(Math.max(...sampleSpring(0, 100, 0, 14, 1).pos)).toBeLessThanOrEqual(100.0001);
  });
  it('trackAt：內插、超出範圍取兩端；被打斷時可接續目前位置與速度', () => {
    const tr = sampleSpring(0, 100, 0, 16, 0.6);
    expect(trackAt(tr, -1).p).toBe(0);
    expect(trackAt(tr, 99).p).toBe(100);
    const mid = trackAt(tr, 0.1);
    expect(mid.p).toBeGreaterThan(0);
    expect(mid.v).toBeGreaterThan(0);
    const next = sampleSpring(mid.p, 0, mid.v, 16, 0.6); // 中途改去反方向
    expect(next.pos[next.pos.length - 1]).toBe(0);
  });
  it('往左走（終點小於起點）與初速度同樣正確', () => {
    const tr = sampleSpring(200, 50, -300, 16, 0.6);
    expect(tr.pos[tr.pos.length - 1]).toBe(50);
    expect(Math.min(...tr.pos)).toBeLessThan(50); // 往左過衝
  });
});

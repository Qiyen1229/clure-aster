/**
 * 煙火動畫：全螢幕 canvas，幾次綻放後自動結束；不擋操作；「減少動態效果」時不播放。
 * play 由 false 變 true 時播放一次。
 */
import { useEffect, useRef } from 'react';

interface P { x: number; y: number; vx: number; vy: number; life: number; max: number; hue: number; size: number }

export function Fireworks({ play, onDone }: { play: boolean; onDone?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!play) return;
    const cv = ref.current;
    if (!cv || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { onDone?.(); return; }
    const ctx = cv.getContext('2d');
    if (!ctx) { onDone?.(); return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth, H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = `${W}px`; cv.style.height = `${H}px`; // 與繪圖座標同尺寸，避免被拉伸
    ctx.scale(dpr, dpr);
    const parts: P[] = [];
    const burst = (x: number, y: number) => {
      const hue = Math.random() * 360;
      for (let i = 0; i < 70; i++) {
        const a = (Math.PI * 2 * i) / 70 + Math.random() * 0.2;
        const sp = 1.5 + Math.random() * 4.2;
        parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 55 + Math.random() * 35, hue: hue + Math.random() * 40, size: 1.6 + Math.random() * 1.6 });
      }
    };
    const t0 = performance.now();
    const shots = [0, 350, 800, 1250, 1700, 2150];
    let next = 0;
    let raf = 0;
    const frame = (now: number) => {
      const t = now - t0;
      while (next < shots.length && t >= shots[next]) { burst(W * (0.2 + Math.random() * 0.6), H * (0.18 + Math.random() * 0.32)); next++; }
      ctx.clearRect(0, 0, W, H);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life++; p.x += p.vx; p.y += p.vy; p.vy += 0.045; p.vx *= 0.985; p.vy *= 0.985;
        if (p.life > p.max) { parts.splice(i, 1); continue; }
        const k = 1 - p.life / p.max;
        ctx.globalAlpha = k;
        ctx.fillStyle = `hsl(${p.hue} 95% 62%)`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.5 + k), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (next < shots.length || parts.length) raf = requestAnimationFrame(frame);
      else { ctx.clearRect(0, 0, W, H); onDone?.(); }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play]);
  if (!play) return null;
  return <canvas ref={ref} aria-hidden="true" style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 120 }} />;
}

/**
 * 語音記帳彈窗（導覽列中間的按鈕長按開啟）。
 * - 長按：按住說話、放開就完成並直接入帳（見 services/voice.ts 的 releaseVoice）
 * - 也可以不長按：在彈窗裡按麥克風開始／暫停，打勾入帳；鍵盤按鈕改用打字修正
 * - 說話時是半透明漸層絲帶的波浪＋飄動的光點，隨語音辨識的回報起伏
 * - 文字框下方即時顯示「將會記成」什麼；解析規則和「一句話記帳」完全相同
 */
import { useEffect, useRef, useState } from 'react';
import { useAccounts, useCategories } from '@/app/hooks';
import { formatMoney, toMinor } from '@/domain/money';
import { shortDate } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { draftsFromText, type ResolvedDraft } from '@/services/quickentry';
import { closeVoice, setVoiceText, startListening, stopListening, submitVoice, useVoice, voiceLevel, voiceSupported } from '@/services/voice';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

const RIBBONS = [
  { c1: '#8b5cf6', c2: '#3b82f6', f: [0.9, 1.7], s: [1.0, -0.6], p: 0.0, up: 1.0, dn: 0.35 },
  { c1: '#22d3ee', c2: '#60a5fa', f: [1.3, 2.3], s: [-0.8, 1.1], p: 1.3, up: 0.55, dn: 0.95 },
  { c1: '#ec4899', c2: '#8b5cf6', f: [0.7, 1.9], s: [0.7, 0.5], p: 2.4, up: 0.9, dn: 0.6 },
  { c1: '#38bdf8', c2: '#a78bfa', f: [1.6, 2.8], s: [-1.2, 0.9], p: 3.6, up: 0.5, dn: 0.6 },
  { c1: '#f59e0b', c2: '#ec4899', f: [1.1, 2.1], s: [0.9, -1.0], p: 4.7, up: 0.35, dn: 0.3 },
];
const DUST = ['#a78bfa', '#67e8f9', '#f9a8d4', '#93c5fd'];

/**
 * 科技感波浪：幾條半透明的漸層絲帶（上下不對稱、相位不同）用「疊加」混色互相透出，
 * 中間一條發光細線，周圍有飄動的光點。振幅追著 level（語音辨識有回報就拉高、之後自然衰減）。
 * 偏好減少動態時只畫一格靜態畫面。
 */
function Wave({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    ctx.scale(dpr, dpr);
    const cy = H / 2;
    const dust = Array.from({ length: 90 }, () => ({
      x: Math.random() * W, off: (Math.random() + Math.random() + Math.random() - 1.5) * 1.2, v: 0.15 + Math.random() * 0.45,
      r: 0.5 + Math.random() * 1.1, c: DUST[Math.floor(Math.random() * DUST.length)], ph: Math.random() * 6.28,
    }));
    const env = (x: number) => Math.pow(Math.sin((Math.PI * x) / W), 1.4);
    const grads = RIBBONS.map((r) => {
      const g = ctx.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, r.c1); g.addColorStop(1, r.c2);
      return g;
    });
    const line = ctx.createLinearGradient(0, 0, W, 0);
    line.addColorStop(0, 'rgba(139,92,246,0)'); line.addColorStop(0.25, 'rgba(139,92,246,0.9)'); line.addColorStop(0.5, 'rgba(103,232,249,1)');
    line.addColorStop(0.75, 'rgba(236,72,153,0.9)'); line.addColorStop(1, 'rgba(236,72,153,0)');
    let t = 0;
    let amp = 0.04;
    let raf = 0;
    const draw = () => {
      const target = activeRef.current ? 0.14 + voiceLevel.current * 0.86 : 0.035;
      amp += (target - amp) * 0.14;
      voiceLevel.current *= 0.93;
      t += 0.035 + amp * 0.09;
      const A = amp * H * 0.5;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      RIBBONS.forEach((r, k) => {
        const top: number[] = [];
        const bot: number[] = [];
        const xs: number[] = [];
        for (let x = 0; x <= W; x += 4) {
          const u = (x / W) * Math.PI * 2;
          const a = 0.5 + 0.5 * (0.6 * Math.sin(u * r.f[0] + t * r.s[0] + r.p) + 0.4 * Math.sin(u * r.f[1] + t * r.s[1] + r.p * 1.7));
          const b = 0.5 + 0.5 * (0.6 * Math.sin(u * r.f[1] + t * r.s[1] * 0.8 + r.p * 2.3) + 0.4 * Math.sin(u * r.f[0] - t * r.s[0] + r.p * 0.6));
          const e = env(x);
          xs.push(x);
          top.push(cy - A * e * r.up * a);
          bot.push(cy + A * e * r.dn * b);
        }
        ctx.beginPath();
        xs.forEach((x, i) => (i ? ctx.lineTo(x, top[i]) : ctx.moveTo(x, top[i])));
        for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], bot[i]);
        ctx.closePath();
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = grads[k];
        ctx.fill();
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = grads[k];
        ctx.stroke();
      });
      // 中間發光細線
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = line;
      ctx.shadowColor = 'rgba(103,232,249,0.9)';
      ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
      ctx.shadowBlur = 0;
      // 光點：集中在波峰附近，飄動閃爍
      for (const d of dust) {
        d.x += d.v * (0.4 + amp * 2);
        if (d.x > W) d.x = 0;
        const y = cy + d.off * A * 1.5 * env(d.x) + Math.sin(t * 2 + d.ph) * 2;
        ctx.globalAlpha = (0.25 + 0.6 * Math.abs(Math.sin(t * 1.6 + d.ph))) * (0.35 + amp * 1.4) * Math.min(1, env(d.x) * 3);
        ctx.fillStyle = d.c;
        ctx.beginPath(); ctx.arc(d.x, y, d.r, 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="voice-wave" aria-hidden="true" />;
}

export function VoiceSheet() {
  const { open, hold, listening, keyboard, text, hint, busy, prompt } = useVoice();
  const { map: accMap } = useAccounts();
  const { map: catMap } = useCategories();
  const [drafts, setDrafts] = useState<ResolvedDraft[]>([]);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const today = todayKey();
  const supported = voiceSupported();

  // 文字有變就即時解析，讓你在入帳前看到會記成什麼
  useEffect(() => {
    if (!open) { setDrafts([]); return; }
    const t = text.trim();
    if (!t) { setDrafts([]); return; }
    let alive = true;
    const id = setTimeout(() => { void draftsFromText(t).then((l) => { if (alive) setDrafts(l); }).catch(() => undefined); }, 250);
    return () => { alive = false; clearTimeout(id); };
  }, [text, open]);

  // 沒有語音辨識：直接開鍵盤
  useEffect(() => { if (open && keyboard && !listening) setTimeout(() => boxRef.current?.focus(), 350); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toKeyboard = () => {
    stopListening();
    useVoice.setState({ keyboard: true });
    setTimeout(() => { const el = boxRef.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 30);
  };

  return (
    <Sheet open={open} onClose={closeVoice} title="語音記帳">
      <div className="voice">
        <Wave active={listening} />
        <p className="voice-status" role="status">
          {hold && listening ? '說話中…放開就完成' : hold ? '放開後，點一下麥克風開始說話' : prompt ? '點一下下方的麥克風，開始說話' : busy ? '記帳中…' : listening ? '正在聽…說完按 ✓' : keyboard ? '用鍵盤輸入' : supported ? '已暫停，按麥克風繼續' : ''}
        </p>
        <div className="voice-box">
          <textarea ref={boxRef} rows={3} value={text} maxLength={300} enterKeyHint="done" aria-label="辨識的內容，可以直接修改"
            placeholder="例如：今天早餐蛋餅 60，午餐 120 刷玉山卡"
            onFocus={() => { if (listening) toKeyboard(); }}
            onChange={(e) => setVoiceText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitVoice(); } }} />
          <button className="icon-btn voice-kb" onClick={toKeyboard} aria-label="用鍵盤修改" aria-pressed={keyboard}><Icon name="keyboard" /></button>
        </div>
        {hint && <p className="quick-hint" role="alert">{hint}</p>}
        {drafts.length > 0 && (
          <div className="list voice-preview" aria-label="將會記成">
            {drafts.map((d, i) => {
              const c = d.categoryId ? catMap.get(d.categoryId) : undefined;
              const acc = accMap.get(d.accountId);
              const cur = d.currency ?? acc?.currency ?? 'TWD';
              return (
                <div key={i} className="row">
                  <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true">{d.kind === 'transfer' ? '🔁' : c?.icon ?? '✨'}</span>
                  <div className="row-main">
                    <div className="row-title">{d.note || c?.name || (d.kind === 'transfer' ? '轉帳' : '未分類')}</div>
                    <div className="row-sub">{shortDate(d.date, today)} · {d.kind === 'transfer' ? `${acc?.name ?? '?'} → ${accMap.get(d.toAccountId ?? '')?.name ?? '?'}` : `${c?.name ?? ''} · ${acc?.name ?? ''}`}</div>
                  </div>
                  <span className={`num ${d.kind === 'income' ? 'pos' : d.kind === 'expense' ? 'neg' : ''}`}>{formatMoney(toMinor(d.amount, cur), cur)}</span>
                </div>
              );
            })}
          </div>
        )}
        {!hold && (
          <div className="voice-actions">
            <button className="voice-side" onClick={closeVoice} aria-label="取消"><Icon name="close" size={24} /></button>
            <button className={`voice-mic${listening ? ' on' : ''}${prompt && !listening ? ' prompt' : ''}`} onClick={() => (listening ? stopListening() : startListening())}
              disabled={!supported} aria-label={listening ? '暫停聆聽' : '開始聆聽'} aria-pressed={listening}><Icon name="mic" size={30} /></button>
            <button className="voice-side ok" onClick={() => void submitVoice()} disabled={!text.trim() || busy} aria-label="完成並入帳"><Icon name="check" size={26} stroke={2.6} /></button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

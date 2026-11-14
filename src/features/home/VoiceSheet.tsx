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
import { closeVoice, setVoiceText, startListening, stopListening, submitVoice, transcribeCurrentRecording, useVoice, voiceLevel, voiceSupported } from '@/services/voice';
import { CatIcon, Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

const BAR_COUNT = 21;

/**
 * 極簡聲紋律動條：單色細膠囊直條隨語音音量柔順起伏，貼合 Aster 設計語言與當前主題色。
 * 偏好減少動態時只繪製靜態一格。
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
    const barW = 2.5;
    const step = Math.min(10, (W - 32) / BAR_COUNT);
    const startX = (W - (BAR_COUNT - 1) * step) / 2;
    let t = 0;
    let amp = 0.08;
    let raf = 0;
    const draw = () => {
      const target = activeRef.current ? 0.22 + voiceLevel.current * 0.78 : 0.08;
      amp += (target - amp) * 0.16;
      voiceLevel.current *= 0.92;
      t += 0.055 + amp * 0.07;
      const color = getComputedStyle(cv).color || '#0a84ff';
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = color;
      for (let i = 0; i < BAR_COUNT; i++) {
        const norm = (i / (BAR_COUNT - 1)) * 2 - 1; // -1..1
        const bell = Math.cos(norm * Math.PI * 0.5);
        const wave = activeRef.current
          ? 0.45 + 0.55 * (0.65 * Math.sin(t * 2.2 + i * 0.55) + 0.35 * Math.cos(t * 1.4 - i * 0.85))
          : 0.2;
        const maxH = H * 0.62;
        const h = Math.max(4, maxH * amp * bell * (0.4 + 0.6 * wave));
        const x = startX + i * step - barW / 2;
        const y = cy - h / 2;
        ctx.globalAlpha = activeRef.current ? 0.45 + 0.55 * bell : 0.25 + 0.15 * bell;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, h, barW / 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
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
          {hold && listening ? '說話中…放開就完成記帳' : busy ? 'Cilo 語音辨識中…' : listening ? '正在錄音…說完按麥克風或 ✓' : prompt ? '點一下下方的麥克風，開始說話' : keyboard ? '用鍵盤輸入' : supported ? '按麥克風開始說話' : ''}
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
                  <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true"><CatIcon icon={d.kind === 'transfer' ? 'repeat' : c?.icon ?? 'sparkles'} size={16} /></span>
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
            <button
              className={`voice-mic${listening ? ' on' : ''}${prompt && !listening ? ' prompt' : ''}`}
              onClick={() => {
                if (listening) {
                  void transcribeCurrentRecording().catch((e) => useVoice.setState({ hint: (e as Error).message }));
                } else {
                  startListening();
                }
              }}
              disabled={!supported || busy}
              aria-label={listening ? '停止並辨識' : '開始錄音'}
              aria-pressed={listening}
            >
              <Icon name="mic" size={30} />
            </button>
            <button className="voice-side ok" onClick={() => void submitVoice()} disabled={(!text.trim() && !listening) || busy} aria-label="完成並入帳"><Icon name="check" size={26} stroke={2.6} /></button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

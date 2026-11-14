/**
 * 語音記帳引擎：採用標準 Web MediaRecorder + AudioContext 音量偵測 + 後端 Gemini 語音轉文字。
 * 徹底避開 iOS Standalone PWA 中 webkitSpeechRecognition（assistantd）短時間無法連續啟動的系統級限制，
 * 支援真正的「按住說話、放開自動記帳」與「輕點錄音、講完點 ✓」，並提供即時真實聲紋振幅。
 */
import { create } from 'zustand';
import { aiEnabledLocally, aiTranscribe } from './ai';

interface VoiceState {
  open: boolean;
  /** 這次是用按住開啟的（放開＝停止並自動辨識入帳） */
  hold: boolean;
  listening: boolean;
  keyboard: boolean;
  text: string;
  hint: string;
  busy: boolean;
  prompt: boolean;
}

export const useVoice = create<VoiceState>(() => ({
  open: false,
  hold: false,
  listening: false,
  keyboard: false,
  text: '',
  hint: '',
  busy: false,
  prompt: false,
}));
const set = (p: Partial<VoiceState>) => useVoice.setState(p);

/** 波浪的振幅來源：由 AudioContext AnalyserNode 即時驅動 */
export const voiceLevel = { current: 0 };

let mediaStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let audioCtx: AudioContext | null = null;
let meterRaf = 0;
let recordToken = 0;

export const voiceSupported = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== 'undefined';

type SpeechRecognitionCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

/** 供 QuickEntry 等元件選用的瀏覽器原生語音辨識建構子（若不支援回傳 null） */
export function speechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** 供其他元件於原生語音結束後釋放音訊狀態的相容 helper */
export function resetVoiceAudio() {
  cleanupAudio();
}

const blockEvent = (e: Event) => e.preventDefault();
let guardTimer = 0;

export function holdGuard(on: boolean) {
  window.clearTimeout(guardTimer);
  if (on) {
    document.documentElement.classList.add('voice-holding');
    document.addEventListener('selectstart', blockEvent, true);
    document.addEventListener('contextmenu', blockEvent, true);
    window.getSelection()?.removeAllRanges();
    return;
  }
  guardTimer = window.setTimeout(() => {
    document.documentElement.classList.remove('voice-holding');
    document.removeEventListener('selectstart', blockEvent, true);
    document.removeEventListener('contextmenu', blockEvent, true);
  }, 350);
}

function pickMime(): { mime: string; format: 'mp4' | 'webm' | 'ogg' } {
  const candidates: { mime: string; format: 'mp4' | 'webm' | 'ogg' }[] = [
    { mime: 'audio/mp4', format: 'mp4' },
    { mime: 'audio/webm;codecs=opus', format: 'webm' },
    { mime: 'audio/webm', format: 'webm' },
    { mime: 'audio/ogg;codecs=opus', format: 'ogg' },
    { mime: 'audio/ogg', format: 'ogg' },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  return { mime: '', format: 'mp4' };
}

function cleanupAudio() {
  if (meterRaf) {
    cancelAnimationFrame(meterRaf);
    meterRaf = 0;
  }
  voiceLevel.current = 0;
  if (audioCtx) {
    try { void audioCtx.close(); } catch { /* ignore */ }
    audioCtx = null;
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    mediaStream = null;
  }
}

function startMeter(stream: MediaStream) {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  try {
    const ctx = new Ctx();
    audioCtx = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (!audioCtx) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      // 靈敏度放大並平滑衰減，讓極簡聲紋自然跟著講話律動
      const level = Math.min(1, rms * 5.5);
      voiceLevel.current = Math.max(level, voiceLevel.current * 0.85);
      meterRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    /* 部分環境若不支援 AudioContext 仍可正常錄音 */
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const s = String(reader.result || '');
      const idx = s.indexOf(',');
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    reader.onerror = () => reject(new Error('音訊讀取失敗'));
    reader.readAsDataURL(blob);
  });
}

/** 開始錄音 */
export function startListening() {
  if (!voiceSupported()) {
    set({ keyboard: true, hint: '這個裝置不支援麥克風錄音，請直接輸入文字' });
    return;
  }
  if (!aiEnabledLocally()) {
    set({ keyboard: true, hint: '語音辨識需要開啟 Cilo（已切換為文字輸入，也可使用 iOS 鍵盤麥克風聽寫）' });
    return;
  }
  stopListening();
  const token = ++recordToken;
  set({ keyboard: false, hint: '', prompt: false, listening: true });

  void navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((stream) => {
      if (token !== recordToken || !useVoice.getState().open || !useVoice.getState().listening) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      mediaStream = stream;
      chunks = [];
      const { mime } = pickMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorder = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      rec.onerror = () => {
        cleanupAudio();
        mediaRecorder = null;
        set({ listening: false, hint: '錄音發生錯誤，請再試一次' });
      };
      rec.start(200);
      startMeter(stream);
    })
    .catch(() => {
      if (token !== recordToken) return;
      set({
        listening: false,
        hint: '無法取得麥克風權限：請在瀏覽器／iPhone 設定允許麥克風，或改用鍵盤輸入',
      });
    });
}

/** 立刻中止錄音（丟棄音訊，不送出辨識） */
export function stopListening() {
  recordToken++;
  const rec = mediaRecorder;
  mediaRecorder = null;
  if (rec && rec.state !== 'inactive') {
    rec.ondataavailable = null;
    rec.onstop = null;
    try { rec.stop(); } catch { /* ignore */ }
  }
  chunks = [];
  cleanupAudio();
  set({ listening: false });
}

/** 停止錄音並送給後端 Gemini 轉成文字 */
export async function transcribeCurrentRecording(): Promise<string> {
  const rec = mediaRecorder;
  mediaRecorder = null;
  const recordedFormat = rec?.mimeType?.includes('webm')
    ? 'webm'
    : rec?.mimeType?.includes('ogg')
      ? 'ogg'
      : 'mp4';

  if (rec && rec.state !== 'inactive') {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1200);
      rec.onstop = () => {
        clearTimeout(timer);
        resolve();
      };
      try { rec.stop(); } catch { clearTimeout(timer); resolve(); }
    });
  }
  cleanupAudio();
  set({ listening: false });

  const blob = new Blob(chunks, { type: rec?.mimeType || 'audio/mp4' });
  chunks = [];
  if (blob.size < 256) return '';

  set({ busy: true, hint: '' });
  try {
    const b64 = await blobToBase64(blob);
    const { text } = await aiTranscribe(b64, recordedFormat);
    const clean = text.trim();
    if (!clean) return '';
    const prev = useVoice.getState().text.trim();
    const next = prev ? `${prev} ${clean}` : clean;
    set({ text: next });
    return next;
  } finally {
    set({ busy: false });
  }
}

export function setVoiceText(text: string) {
  set({ text, hint: '' });
}

export function openVoice(hold = false, _fromGesture = false) {
  set({
    open: true,
    hold: hold && voiceSupported() && aiEnabledLocally(),
    listening: false,
    keyboard: false,
    text: '',
    hint: '',
    busy: false,
    prompt: false,
  });
  startListening();
}

export function closeVoice() {
  stopListening();
  set({ open: false, hold: false, busy: false });
}

/** 文字轉成帳目並入帳；若仍在錄音中會先停止並辨識後再入帳 */
export async function submitVoice(): Promise<boolean> {
  if (useVoice.getState().busy) return false;
  if (useVoice.getState().listening) {
    try {
      await transcribeCurrentRecording();
    } catch (e) {
      set({ hint: (e as Error).message });
      return false;
    }
  }
  const t = useVoice.getState().text.trim();
  if (!t) {
    set({ hint: '沒有聽到語音內容，請再按一次麥克風說話' });
    return false;
  }
  set({ busy: true, hold: false });
  try {
    const [{ bookDrafts, draftsSmart }, { deleteTransactions, deleteTransfers }, { snackUndo }] = await Promise.all([
      import('./quickentry'),
      import('@/db/repo/ledger'),
      import('@/stores/ui'),
    ]);
    const { list, aiNote } = await draftsSmart(t);
    if (!list.length) {
      set({ hint: `找不到金額：試試「午餐 120」或「計程車兩百三」${aiNote ?? ''}` });
      return false;
    }
    const r = await bookDrafts(list);
    closeVoice();
    snackUndo(`已記下 ${list.length} 筆`, async () => {
      if (r.txIds.length) await deleteTransactions(r.txIds);
      if (r.transferIds.length) await deleteTransfers(r.transferIds);
    });
    return true;
  } catch (e) {
    set({ hint: (e as Error).message });
    return false;
  } finally {
    set({ busy: false });
  }
}

/** 放開語音鈕：輕點（< 350ms）轉為一般錄音模式繼續收音；長按（>= 350ms）停止錄音、轉文字並直接入帳 */
export async function releaseVoice(elapsedMs?: number) {
  const s = useVoice.getState();
  if (!s.open || !s.hold) return;
  if (elapsedMs !== undefined && elapsedMs < 350) {
    set({ hold: false });
    return;
  }
  set({ hold: false });
  try {
    const text = await transcribeCurrentRecording();
    if (!useVoice.getState().open) return;
    if (!text) {
      closeVoice();
      const { useUI } = await import('@/stores/ui');
      useUI.getState().showSnack({ text: '沒有聽到內容，長按再說一次' });
      return;
    }
    await submitVoice();
  } catch (e) {
    set({ hint: (e as Error).message });
  }
}

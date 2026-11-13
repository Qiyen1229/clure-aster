/**
 * 語音記帳引擎：瀏覽器的語音辨識 + 狀態（給 VoiceSheet 顯示）。
 * 放在全域而不是元件裡，因為「長按導覽列中間的按鈕」要在手指按下的那一刻就同步開始辨識
 * （iOS 只允許在使用者手勢裡啟動語音辨識），不能等元件渲染完才開始。
 *
 * 兩種用法：
 * - 長按（hold）：按住說話、放開就完成並直接入帳；沒聽到或看不懂金額時留在彈窗讓你修正
 * - 一般：在彈窗裡按麥克風開始／暫停，打勾入帳
 */
import { create } from 'zustand';

export function speechRecognition(): (new () => any) | undefined {
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
}

interface VoiceState {
  open: boolean;
  /** 這次是用長按開啟的（放開＝完成） */
  hold: boolean;
  listening: boolean;
  keyboard: boolean;
  text: string;
  hint: string;
  busy: boolean;
  /** iPhone：長按放開後，要點一下麥克風才能開始聽（放開不算使用者手勢） */
  prompt: boolean;
}

export const useVoice = create<VoiceState>(() => ({ open: false, hold: false, listening: false, keyboard: false, text: '', hint: '', busy: false, prompt: false }));
const set = (p: Partial<VoiceState>) => useVoice.setState(p);

/** 波浪的振幅來源：語音辨識有回報就拉高，畫面那邊每一格衰減 */
export const voiceLevel = { current: 0 };

let rec: any = null;
let recActive = false;
let sessionSeq = 0;
let want = false;
let finalText = '';
let startedAt = 0;
let quickEnds = 0;
/**
 * 真的聽到聲音了（有 onsoundstart／onspeechstart／辨識結果）。只有 onstart 不算：
 * iOS 在非手勢（長按的計時器）裡啟動時，onstart 照樣會觸發、也不報錯，但根本沒有收到任何聲音，之後放開也沒有結果
 */
let heard = false;
/** iPhone／iPad（含偽裝成 Mac 的 iPadOS）：確定不能在長按的計時器裡啟動語音辨識 */
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** 用過一次就保留：Sheet 要曾經掛載過才需要渲染（關閉動畫要播完） */
export const voiceSupported = () => !!speechRecognition();

const blockEvent = (e: Event) => e.preventDefault();
let guardTimer = 0;

/**
 * 長按期間禁止選取文字與長按選單（iOS 長按會跳出放大鏡／選取，網頁沒有別的辦法關掉）：
 * - html.voice-holding：全部 user-select: none，並且讓彈窗不擋住手指（否則長按會落在彈窗的文字或輸入框上而變成選取）
 * - 攔截 selectstart／contextmenu，並清掉已經選到的範圍
 * 放開後稍等一下才解除，避免放開那一刻又觸發一次。
 */
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

function bump() { voiceLevel.current = Math.max(voiceLevel.current, 0.55 + Math.random() * 0.45); }

/** 開始（或繼續）聆聽，接在目前的文字後面 */
export function startListening() {
  const SR = speechRecognition();
  if (!SR) return;
  const ios = isIOS();
  const sid = ++sessionSeq;
  if (rec && recActive) {
    try { if (ios) rec.stop(); else rec.abort(); } catch { /* 忽略 */ }
    recActive = false;
  }
  want = true;
  heard = false;
  finalText = useVoice.getState().text;
  set({ keyboard: false, hint: '', prompt: false });

  const bind = (r: any) => {
    r.lang = 'zh-TW';
    // iOS WebKit 開啟 continuous=true 或 interimResults=true 常導致 assistantd 佔用麥克風約 15-30 秒無法連續第二次啟動
    r.continuous = !ios;
    r.interimResults = !ios;
    r.maxAlternatives = 1;
    r.onstart = () => {
      if (sid !== sessionSeq) return;
      recActive = true;
      startedAt = Date.now();
      set({ listening: true });
    };
    r.onsoundstart = () => { if (sid === sessionSeq) { heard = true; bump(); } };
    r.onspeechstart = () => { if (sid === sessionSeq) { heard = true; bump(); } };
    r.onresult = (e: any) => {
      if (sid !== sessionSeq) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript; else interim += res[0].transcript;
      }
      quickEnds = 0;
      heard = true;
      bump();
      set({ text: finalText + interim });
    };
    r.onerror = (e: any) => {
      recActive = false;
      if (sid !== sessionSeq) return;
      if (e.error === 'no-speech' || e.error === 'aborted') {
        set({ listening: false });
        return;
      }
      want = false;
      if (useVoice.getState().hold && !heard) { set({ listening: false }); return; }
      set({
        listening: false,
        hint: e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? '無法使用麥克風或語音辨識：請在瀏覽器／iPhone 設定允許，或按鍵盤改用打字'
          : '語音辨識失敗：請再按一次麥克風，或按鍵盤改用打字',
      });
    };
    r.onend = () => {
      recActive = false;
      if (sid !== sessionSeq) return;
      set({ listening: false });
      // iOS 在 setTimeout 裡重啟語音會失去手勢資格而卡死，停止即可；桌面／Android 才自動續聽
      if (!want || ios) { want = false; return; }
      quickEnds = Date.now() - startedAt < 1000 ? quickEnds + 1 : 0;
      if (quickEnds >= 3) { want = false; set({ hint: '語音辨識中斷了，請再按一次麥克風' }); return; }
      setTimeout(() => { if (want && sid === sessionSeq && rec === r) { try { r.start(); } catch { /* 忽略 */ } } }, 150);
    };
  };

  // iOS 優先重用同一顆語音辨識實例，避免重建釋放延遲導致短時間內無法再次收音
  const r = ios && rec ? rec : new SR();
  rec = r;
  bind(r);
  try {
    r.start();
    recActive = true;
  } catch {
    // 若舊實例尚未完全釋放（InvalidStateError），改建新實例重試一次
    if (ios) {
      const fresh = new SR();
      rec = fresh;
      bind(fresh);
      try { fresh.start(); recActive = true; return; } catch { /* fallthrough */ }
    }
    recActive = false;
    set({ hint: '語音引擎忙線中，請稍候再點一次麥克風' });
  }
}

/** 立刻停止（保留 onend 清理，確保 iOS 音訊階段正常釋放） */
export function stopListening() {
  want = false;
  sessionSeq++;
  const r = rec;
  if (r && recActive) {
    try { if (isIOS()) r.stop(); else r.abort(); } catch { /* 已停止 */ }
  }
  recActive = false;
  set({ listening: false });
}

/** 使用者改了文字（鍵盤修改）：之後再聽就接在這段後面 */
export function setVoiceText(text: string) {
  finalText = text;
  set({ text, hint: '' });
}

/** 打開語音彈窗。hold：按住進來的（放開＝完成）；fromGesture：在 pointerdown 同步呼叫時 iOS 也能直接收音 */
export function openVoice(hold = false, fromGesture = false) {
  const supported = voiceSupported();
  finalText = '';
  quickEnds = 0;
  heard = false;
  set({ open: true, hold: hold && supported, listening: false, keyboard: false, text: '', hint: '', busy: false, prompt: false });
  if (!supported) set({ keyboard: true, hint: '這個瀏覽器沒有語音辨識：請按鍵盤上的麥克風（聽寫）說出來' });
  // 若非同步手勢觸發（例如長按計時器）且為 iOS，無法啟動收音；由同步 pointerdown 觸發（fromGesture=true）則可直接啟動
  else if (fromGesture || !(hold && isIOS())) startListening();
}

export function closeVoice() {
  stopListening();
  set({ open: false, hold: false, busy: false });
}

/** 文字轉成帳目並入帳；看不懂時回傳 false，留在彈窗讓使用者修正 */
export async function submitVoice(): Promise<boolean> {
  const t = useVoice.getState().text.trim();
  if (!t || useVoice.getState().busy) return false;
  stopListening();
  set({ busy: true, hold: false });
  try {
    const [{ bookDrafts, draftsSmart }, { deleteTransactions, deleteTransfers }, { snackUndo }] = await Promise.all([
      import('./quickentry'), import('@/db/repo/ledger'), import('@/stores/ui'),
    ]);
    const { list, aiNote } = await draftsSmart(t);
    if (!list.length) { set({ hint: `找不到金額：試試「午餐 120」或「計程車兩百三」${aiNote ?? ''}` }); return false; }
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
  } finally { set({ busy: false }); }
}

/** 放開語音鈕：輕點（< 350ms）轉為一般聆聽模式；長按（>= 350ms）等最後辨識結果後直接入帳 */
export async function releaseVoice(elapsedMs?: number) {
  const s = useVoice.getState();
  if (!s.open || !s.hold) return;
  if (elapsedMs !== undefined && elapsedMs < 350) {
    set({ hold: false });
    return;
  }
  // 長按時沒聽到聲音（辨識沒能開始）：改成一般模式。
  // iPhone：實測長按放開（pointerup／touchend）都不算使用者手勢，這時啟動會假裝在聽卻收不到聲音，
  //         只有真正的點一下（click）可以 → 不自動開始，請使用者點一下麥克風（和一般點開語音彈窗一樣）
  // Android／電腦：放開的這一刻還在手勢裡（所以這裡不能有 await 在前面），直接開始聽
  if (!heard) {
    stopListening();
    set({ hold: false });
    if (isIOS()) { set({ prompt: true }); return; }
    startListening();
    return;
  }
  const r = rec;
  want = false;
  if (r) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1500);
      r.onend = () => { clearTimeout(t); resolve(); };
      try { r.stop(); } catch { clearTimeout(t); resolve(); }
    });
    rec = null;
  }
  // 若等待期間使用者按了取消（open 已為 false），直接退出，不入帳
  if (!useVoice.getState().open) return;
  set({ listening: false, hold: false });
  if (!useVoice.getState().text.trim()) {
    closeVoice();
    const { useUI } = await import('@/stores/ui');
    useUI.getState().showSnack({ text: '沒有聽到內容，長按再說一次' });
    return;
  }
  await submitVoice();
}

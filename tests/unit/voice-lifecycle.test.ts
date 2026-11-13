// @vitest-environment jsdom
/**
 * 語音記帳生命週期（iOS assistantd 音訊鎖死問題的修復驗證）：
 * - 每輪一律建新實例，舊實例 detach 後 stop（iOS 不用 abort）
 * - 每輪結束後排程 getUserMedia 取放麥克風，重置音訊階段；新一輪開始會取消排程
 * - start() 忙線、7 秒靜默看門狗、舊實例延遲事件不污染新 session
 * - 桌面／Android 維持 continuous 自動續聽；進背景自動釋放
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as voice from '@/services/voice';
import { useVoice } from '@/services/voice';

class FakeSR {
  static instances: FakeSR[] = [];
  static failNext = false;
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: any = null;
  onaudiostart: any = null;
  onsoundstart: any = null;
  onspeechstart: any = null;
  onresult: any = null;
  onerror: any = null;
  onspeechend: any = null;
  onsoundend: any = null;
  onaudioend: any = null;
  onend: any = null;
  onnomatch: any = null;
  constructor() { FakeSR.instances.push(this); }
  start() { if (FakeSR.failNext) { FakeSR.failNext = false; throw new Error('busy'); } }
  stop() { /* 引擎停止 */ }
  abort() { /* 引擎中止 */ }
}
const startSpy = vi.spyOn(FakeSR.prototype, 'start');
const stopSpy = vi.spyOn(FakeSR.prototype, 'stop');
const abortSpy = vi.spyOn(FakeSR.prototype, 'abort');
(window as any).SpeechRecognition = FakeSR;

const trackStop = vi.fn();
const gum = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }));
Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: gum }, configurable: true });

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const setUA = (ua: string) => Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });

const fire = (r: any, name: string, e: any = {}) => { if (r[name]) r[name](e); };
const resultEvent = (parts: { transcript: string; isFinal: boolean }[], resultIndex = 0) => ({
  resultIndex,
  results: parts.map((p) => ({ 0: { transcript: p.transcript }, isFinal: p.isFinal })),
});

// 每個測試用不同的時鐘起點：避免上一輪的 lastReset（400ms 去重）擋住這一輪的音訊重置
let clockBase = 1_700_000_000_000;

beforeEach(async () => {
  vi.useFakeTimers({ now: clockBase });
  clockBase += 60_000;
  setUA(IPHONE_UA);
  voice.stopListening();
  await vi.advanceTimersByTimeAsync(600); // 消化上一輪殘留的重置／續聽排程
  FakeSR.instances.length = 0;
  FakeSR.failNext = false;
  startSpy.mockClear(); stopSpy.mockClear(); abortSpy.mockClear();
  gum.mockClear(); trackStop.mockClear();
  useVoice.setState({ open: false, hold: false, listening: false, keyboard: false, text: '', hint: '', busy: false, prompt: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('語音生命週期：iOS 每輪新實例＋音訊階段重置', () => {
  it('iOS：每輪建新實例，舊實例 detach 後用 stop（不是 abort），關閉 continuous／interim', () => {
    voice.openVoice(false, true);
    const r1 = FakeSR.instances[0];
    expect(FakeSR.instances).toHaveLength(1);
    expect(r1.lang).toBe('zh-TW');
    expect(r1.continuous).toBe(false);
    expect(r1.interimResults).toBe(false);
    fire(r1, 'onstart');
    expect(useVoice.getState().listening).toBe(true);

    voice.startListening(); // 短時間內再按一次麥克風
    const r2 = FakeSR.instances[1];
    expect(FakeSR.instances).toHaveLength(2);
    expect(r2).not.toBe(r1);
    expect(stopSpy).toHaveBeenCalled();
    expect(abortSpy).not.toHaveBeenCalled();
    expect(r1.onend).toBeNull();
    expect(r1.onresult).toBeNull();
    expect(r1.onerror).toBeNull();
  });

  it('桌面：維持 continuous＋interimResults，停止用 abort，不做音訊重置', async () => {
    setUA(DESKTOP_UA);
    voice.openVoice(false, true);
    const r = FakeSR.instances[0];
    expect(r.continuous).toBe(true);
    expect(r.interimResults).toBe(true);
    voice.stopListening();
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(gum).not.toHaveBeenCalled();
  });

  it('iOS：停止後 250ms 用 getUserMedia 取放麥克風重置音訊階段', async () => {
    voice.openVoice(false, true);
    fire(FakeSR.instances[0], 'onstart');
    voice.stopListening();
    expect(gum).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(gum).toHaveBeenCalledWith({ audio: true });
    expect(trackStop).toHaveBeenCalledTimes(1);
  });

  it('iOS：重置排程未完成就再開始 → 取消重置，不打斷新一輪', async () => {
    voice.openVoice(false, true);
    voice.stopListening();
    await vi.advanceTimersByTimeAsync(100);
    voice.openVoice(false, true);
    await vi.advanceTimersByTimeAsync(400);
    expect(gum).not.toHaveBeenCalled();
    expect(FakeSR.instances).toHaveLength(2);
  });

  it('iOS：onend 後釋放實例＋重置音訊，不自動重啟；下一輪又是新實例', async () => {
    voice.openVoice(false, true);
    const r1 = FakeSR.instances[0];
    fire(r1, 'onstart');
    fire(r1, 'onend');
    expect(useVoice.getState().listening).toBe(false);
    expect(r1.onend).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(gum).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1); // iOS 不在計時器裡重啟（會失去手勢資格）
    voice.openVoice(false, true);
    expect(FakeSR.instances).toHaveLength(2);
  });

  it('iOS：start() 忙線 → 提示稍候再試＋重置音訊，下一輪就能成功', async () => {
    FakeSR.failNext = true;
    voice.openVoice(false, true);
    expect(useVoice.getState().hint).toContain('忙線');
    expect(useVoice.getState().listening).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(gum).toHaveBeenCalledTimes(1);
    voice.openVoice(false, true);
    expect(FakeSR.instances).toHaveLength(2);
    fire(FakeSR.instances[1], 'onstart');
    expect(useVoice.getState().listening).toBe(true);
    expect(useVoice.getState().hint).toBe('');
  });

  it('iOS：onstart 後 7 秒沒收到任何聲音 → 自動停止＋提示＋重置（不再假裝在聽）', async () => {
    voice.openVoice(false, true);
    const r = FakeSR.instances[0];
    fire(r, 'onstart');
    await vi.advanceTimersByTimeAsync(6999);
    expect(useVoice.getState().listening).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(useVoice.getState().listening).toBe(false);
    expect(useVoice.getState().hint).toContain('沒收到聲音');
    expect(stopSpy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('iOS：有聽到聲音就不觸發靜默看門狗', async () => {
    voice.openVoice(false, true);
    const r = FakeSR.instances[0];
    fire(r, 'onstart');
    await vi.advanceTimersByTimeAsync(3000);
    fire(r, 'onsoundstart');
    await vi.advanceTimersByTimeAsync(5000);
    expect(useVoice.getState().listening).toBe(true);
    expect(useVoice.getState().hint).toBe('');
    expect(gum).not.toHaveBeenCalled();
  });

  it('舊實例的延遲事件（已 detach）不會污染新 session 的文字與狀態', () => {
    voice.openVoice(false, true);
    const r1 = FakeSR.instances[0];
    fire(r1, 'onstart');
    voice.startListening();
    const r2 = FakeSR.instances[1];
    fire(r2, 'onstart');
    fire(r2, 'onresult', resultEvent([{ transcript: '午餐 120', isFinal: true }]));
    expect(useVoice.getState().text).toBe('午餐 120');
    fire(r1, 'onresult', resultEvent([{ transcript: '雜訊', isFinal: true }]));
    fire(r1, 'onend');
    fire(r1, 'onerror', { error: 'network' });
    expect(useVoice.getState().text).toBe('午餐 120');
    expect(useVoice.getState().listening).toBe(true);
    expect(useVoice.getState().hint).toBe('');
  });

  it('no-speech：只停止聆聽，不顯示錯誤提示，並重置音訊', async () => {
    voice.openVoice(false, true);
    const r = FakeSR.instances[0];
    fire(r, 'onstart');
    fire(r, 'onerror', { error: 'no-speech' });
    expect(useVoice.getState().listening).toBe(false);
    expect(useVoice.getState().hint).toBe('');
    await vi.advanceTimersByTimeAsync(300);
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('not-allowed：顯示權限提示並引導改用鍵盤', () => {
    voice.openVoice(false, true);
    const r = FakeSR.instances[0];
    fire(r, 'onstart');
    fire(r, 'onerror', { error: 'not-allowed' });
    expect(useVoice.getState().listening).toBe(false);
    expect(useVoice.getState().hint).toContain('無法使用麥克風');
    expect(useVoice.getState().hint).toContain('鍵盤');
  });

  it('桌面：一般結束 150ms 後自動續聽（同一實例），不建新實例', async () => {
    setUA(DESKTOP_UA);
    voice.openVoice(false, true);
    const r = FakeSR.instances[0];
    fire(r, 'onstart');
    await vi.advanceTimersByTimeAsync(2000);
    fire(r, 'onend');
    expect(startSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(FakeSR.instances).toHaveLength(1);
    fire(r, 'onstart');
    expect(useVoice.getState().listening).toBe(true);
  });

  it('桌面：連續 3 次秒斷 → 停止續聽並提示再按一次麥克風', async () => {
    setUA(DESKTOP_UA);
    voice.openVoice(false, true);
    const r = FakeSR.instances[0];
    fire(r, 'onstart');
    for (let i = 0; i < 3; i++) {
      fire(r, 'onend');
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(startSpy).toHaveBeenCalledTimes(3);
    expect(useVoice.getState().hint).toContain('中斷');
    expect(r.onend).toBeNull();
  });

  it('進背景（visibilitychange hidden）：自動停止並釋放音訊', async () => {
    voice.openVoice(false, true);
    const r = FakeSR.instances[0];
    fire(r, 'onstart');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(useVoice.getState().listening).toBe(false);
    expect(stopSpy).toHaveBeenCalled();
    expect(r.onend).toBeNull();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('interim 與 final 結果正確累積（final 接在 final 後，interim 只暫示）', () => {
    setUA(DESKTOP_UA);
    voice.openVoice(false, true);
    const r = FakeSR.instances[0];
    fire(r, 'onstart');
    fire(r, 'onresult', resultEvent([{ transcript: '午餐', isFinal: false }]));
    expect(useVoice.getState().text).toBe('午餐');
    fire(r, 'onresult', resultEvent([{ transcript: '午餐 120', isFinal: true }]));
    expect(useVoice.getState().text).toBe('午餐 120');
    fire(r, 'onresult', resultEvent([
      { transcript: '午餐 120', isFinal: true },
      { transcript: '晚餐 80', isFinal: true },
    ], 1));
    expect(useVoice.getState().text).toBe('午餐 120晚餐 80');
  });

  it('iOS 長按放開但沒聽到聲音：轉為「點一下麥克風」提示，不卡在假聆聽', async () => {
    voice.openVoice(true, true);
    const r = FakeSR.instances[0];
    fire(r, 'onstart');
    await voice.releaseVoice(500);
    expect(useVoice.getState().hold).toBe(false);
    expect(useVoice.getState().prompt).toBe(true);
    expect(useVoice.getState().listening).toBe(false);
    expect(stopSpy).toHaveBeenCalled();
  });

  it('沒有語音辨識 API：開鍵盤模式並提示用鍵盤聽寫', () => {
    const SR = (window as any).SpeechRecognition;
    delete (window as any).SpeechRecognition;
    voice.openVoice(false, true);
    expect(useVoice.getState().keyboard).toBe(true);
    expect(useVoice.getState().hint).toContain('鍵盤');
    expect(FakeSR.instances).toHaveLength(0);
    (window as any).SpeechRecognition = SR;
  });
});
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const aiEnabledLocallyMock = vi.fn<() => boolean>(() => true);
const aiTranscribeMock = vi.fn<(b64: string, fmt: 'mp4' | 'webm' | 'ogg') => Promise<{ text: string; quota: null }>>(
  async () => ({ text: '午餐 120', quota: null }),
);
const draftsSmartMock = vi.fn<(t: string) => Promise<{ list: { kind: string; amount: number; note: string }[]; aiNote?: string }>>(
  async () => ({
    list: [{ kind: 'expense', amount: 120, note: '午餐' }],
    aiNote: undefined,
  }),
);
const bookDraftsMock = vi.fn<(list: unknown[]) => Promise<{ txIds: string[]; transferIds: string[] }>>(
  async () => ({ txIds: ['tx-1'], transferIds: [] }),
);
const deleteTransactionsMock = vi.fn<(ids: string[]) => Promise<void>>(async () => undefined);
const deleteTransfersMock = vi.fn<(ids: string[]) => Promise<void>>(async () => undefined);
const snackUndoMock = vi.fn();
const showSnackMock = vi.fn();

vi.mock('@/services/ai', () => ({
  aiEnabledLocally: () => aiEnabledLocallyMock(),
  aiTranscribe: (b64: string, fmt: 'mp4' | 'webm' | 'ogg') => aiTranscribeMock(b64, fmt),
}));

vi.mock('@/services/quickentry', () => ({
  draftsSmart: (t: string) => draftsSmartMock(t),
  bookDrafts: (list: unknown[]) => bookDraftsMock(list),
}));

vi.mock('@/db/repo/ledger', () => ({
  deleteTransactions: (ids: string[]) => deleteTransactionsMock(ids),
  deleteTransfers: (ids: string[]) => deleteTransfersMock(ids),
}));

vi.mock('@/stores/ui', () => ({
  snackUndo: (...args: unknown[]) => snackUndoMock(...args),
  useUI: { getState: () => ({ showSnack: showSnackMock }) },
}));

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supportedMimes = new Set<string>(['audio/mp4']);
  static nextAudioBytes = 512;

  static isTypeSupported(mime: string) {
    return FakeMediaRecorder.supportedMimes.has(mime);
  }

  stream: MediaStream;
  mimeType: string;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(stream: MediaStream, opts?: { mimeType?: string }) {
    this.stream = stream;
    this.mimeType = opts?.mimeType || 'audio/mp4';
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    const bytes = new Uint8Array(FakeMediaRecorder.nextAudioBytes).fill(65);
    this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const trackStop = vi.fn();
const fakeStream = {
  getTracks: () => [{ stop: trackStop }],
} as unknown as MediaStream;
const gum = vi.fn(async () => fakeStream);

Object.defineProperty(navigator, 'mediaDevices', {
  value: { getUserMedia: gum },
  configurable: true,
});
(globalThis as unknown as { MediaRecorder: typeof FakeMediaRecorder }).MediaRecorder = FakeMediaRecorder;

const voice = await import('@/services/voice');
const { useVoice } = voice;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  FakeMediaRecorder.instances.length = 0;
  FakeMediaRecorder.supportedMimes = new Set(['audio/mp4']);
  FakeMediaRecorder.nextAudioBytes = 512;
  (globalThis as unknown as { MediaRecorder: typeof FakeMediaRecorder }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: gum },
    configurable: true,
  });

  aiEnabledLocallyMock.mockReset().mockReturnValue(true);
  aiTranscribeMock.mockReset().mockResolvedValue({ text: '午餐 120', quota: null });
  draftsSmartMock.mockReset().mockResolvedValue({
    list: [{ kind: 'expense', amount: 120, note: '午餐' }],
    aiNote: undefined,
  });
  bookDraftsMock.mockReset().mockResolvedValue({ txIds: ['tx-1'], transferIds: [] });
  snackUndoMock.mockReset();
  showSnackMock.mockReset();
  gum.mockReset().mockResolvedValue(fakeStream);
  trackStop.mockReset();

  voice.stopListening();
  useVoice.setState({
    open: false,
    hold: false,
    listening: false,
    keyboard: false,
    text: '',
    hint: '',
    busy: false,
    prompt: false,
  });
});

afterEach(() => {
  voice.stopListening();
});

describe('語音生命週期：MediaRecorder + Gemini 語音轉文字', () => {
  it('openVoice(false) 開啟麥克風並啟動 MediaRecorder', async () => {
    voice.openVoice(false, true);
    await flushMicrotasks();

    expect(useVoice.getState().open).toBe(true);
    expect(useVoice.getState().hold).toBe(false);
    expect(useVoice.getState().listening).toBe(true);
    expect(gum).toHaveBeenCalledWith({ audio: true });
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0].state).toBe('recording');
    expect(FakeMediaRecorder.instances[0].mimeType).toBe('audio/mp4');
  });

  it('輕點（< 350ms）放開後維持錄音狀態，不會中止或送出', async () => {
    voice.openVoice(true, true);
    await flushMicrotasks();
    expect(useVoice.getState().hold).toBe(true);

    await voice.releaseVoice(180);

    expect(useVoice.getState().hold).toBe(false);
    expect(useVoice.getState().listening).toBe(true);
    expect(FakeMediaRecorder.instances[0].state).toBe('recording');
    expect(aiTranscribeMock).not.toHaveBeenCalled();
  });

  it('長按（>= 350ms）放開後停止錄音、轉文字、入帳並關閉面板', async () => {
    FakeMediaRecorder.supportedMimes = new Set(['audio/webm;codecs=opus']);
    voice.openVoice(true, true);
    await flushMicrotasks();

    await voice.releaseVoice(600);

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(aiTranscribeMock).toHaveBeenCalledTimes(1);
    expect(aiTranscribeMock.mock.calls[0][1]).toBe('webm');
    expect(typeof aiTranscribeMock.mock.calls[0][0]).toBe('string');
    expect(aiTranscribeMock.mock.calls[0][0].length).toBeGreaterThan(0);

    expect(draftsSmartMock).toHaveBeenCalledWith('午餐 120');
    expect(bookDraftsMock).toHaveBeenCalledTimes(1);
    expect(snackUndoMock).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().open).toBe(false);
    expect(useVoice.getState().listening).toBe(false);
  });

  it('長按放開但音訊過短（< 256 bytes）→ 不呼叫轉文字，關閉面板並提示', async () => {
    FakeMediaRecorder.nextAudioBytes = 100;
    voice.openVoice(true, true);
    await flushMicrotasks();

    await voice.releaseVoice(500);

    expect(aiTranscribeMock).not.toHaveBeenCalled();
    expect(bookDraftsMock).not.toHaveBeenCalled();
    expect(useVoice.getState().open).toBe(false);
    expect(showSnackMock).toHaveBeenCalledWith({ text: '沒有聽到內容，長按再說一次' });
  });

  it('連續錄音辨識會以空白銜接既有文字', async () => {
    voice.openVoice(false, true);
    await flushMicrotasks();
    aiTranscribeMock.mockResolvedValueOnce({ text: '早餐 50', quota: null });
    await voice.transcribeCurrentRecording();
    expect(useVoice.getState().text).toBe('早餐 50');

    voice.startListening();
    await flushMicrotasks();
    aiTranscribeMock.mockResolvedValueOnce({ text: '咖啡 65', quota: null });
    await voice.transcribeCurrentRecording();
    expect(useVoice.getState().text).toBe('早餐 50 咖啡 65');
  });

  it('submitVoice：錄音中按下 ✓ 會先轉文字再入帳', async () => {
    voice.openVoice(false, true);
    await flushMicrotasks();

    const ok = await voice.submitVoice();

    expect(ok).toBe(true);
    expect(aiTranscribeMock).toHaveBeenCalledTimes(1);
    expect(bookDraftsMock).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().open).toBe(false);
  });

  it('submitVoice：無文字時提示再按一次麥克風；找不到金額時顯示提示', async () => {
    voice.openVoice(false, true);
    await flushMicrotasks();
    voice.stopListening();

    expect(await voice.submitVoice()).toBe(false);
    expect(useVoice.getState().hint).toBe('沒有聽到語音內容，請再按一次麥克風說話');

    voice.setVoiceText('今天天氣不錯');
    draftsSmartMock.mockResolvedValueOnce({ list: [], aiNote: undefined });
    expect(await voice.submitVoice()).toBe(false);
    expect(useVoice.getState().hint).toContain('找不到金額');
  });

  it('closeVoice / stopListening 會停止錄音並釋放麥克風軌道，不送出辨識', async () => {
    voice.openVoice(false, true);
    await flushMicrotasks();

    voice.closeVoice();

    expect(FakeMediaRecorder.instances[0].state).toBe('inactive');
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(aiTranscribeMock).not.toHaveBeenCalled();
    expect(useVoice.getState().open).toBe(false);
    expect(useVoice.getState().listening).toBe(false);
  });

  it('麥克風權限被拒 → 停止錄音並顯示權限提示', async () => {
    gum.mockRejectedValueOnce(new Error('Permission denied'));
    voice.openVoice(false, true);
    await flushMicrotasks();

    expect(useVoice.getState().listening).toBe(false);
    expect(useVoice.getState().hint).toContain('無法取得麥克風權限');
  });

  it('Cilo 未開啟 → 切換為鍵盤輸入並提示，不要求麥克風', () => {
    aiEnabledLocallyMock.mockReturnValue(false);
    voice.openVoice(true, true);

    expect(useVoice.getState().keyboard).toBe(true);
    expect(useVoice.getState().hold).toBe(false);
    expect(useVoice.getState().hint).toContain('需要開啟 Cilo');
    expect(gum).not.toHaveBeenCalled();
  });

  it('裝置不支援 MediaRecorder → 切換為鍵盤輸入並提示', () => {
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = undefined;
    voice.openVoice(false, true);

    expect(useVoice.getState().keyboard).toBe(true);
    expect(useVoice.getState().hint).toContain('不支援麥克風錄音');
    expect(gum).not.toHaveBeenCalled();
  });

  it('aiTranscribe 失敗 → 顯示錯誤訊息且重置 busy 狀態', async () => {
    aiTranscribeMock.mockRejectedValueOnce(new Error('語音辨識額度不足'));
    voice.openVoice(true, true);
    await flushMicrotasks();

    await voice.releaseVoice(500);

    expect(useVoice.getState().busy).toBe(false);
    expect(useVoice.getState().open).toBe(true);
    expect(useVoice.getState().hint).toBe('語音辨識額度不足');
  });
});

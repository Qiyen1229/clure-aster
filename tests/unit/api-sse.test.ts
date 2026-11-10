import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiSse, StreamUnsupported } from '@/services/api';

const enc = new TextEncoder();
/** 把文字切成指定的幾段送出（模擬網路把一個事件拆在兩個封包裡） */
function sse(parts: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}
const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

beforeEach(() => { vi.stubGlobal('document', { cookie: 'csrf_token=t' }); });
afterEach(() => vi.unstubAllGlobals());

describe('讀取 SSE 事件流', () => {
  it('逐段收到 delta，最後回傳 done 的資料；事件被拆在不同封包也能拼回來', async () => {
    const full = ev('delta', { t: '近三個月' }) + ev('delta', { t: '平均 3 萬。' }) + ev('done', { answer: '近三個月平均 3 萬。', followups: [], quota: {} });
    const cut = full.indexOf('平均') + 2; // 刻意切在事件中間（還有中文字被切半的位元組）
    const bytes = enc.encode(full);
    const first = bytes.slice(0, enc.encode(full.slice(0, cut)).length - 1);
    const second = bytes.slice(first.length);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(first); c.enqueue(second); c.close(); } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })));
    const seen: string[] = [];
    const r = await apiSse<{ answer: string }>('/ai/ask/stream', { question: 'q' }, (n, d) => { if (n === 'delta') seen.push((d as { t: string }).t); });
    expect(seen.join('')).toBe('近三個月平均 3 萬。');
    expect(r.answer).toBe('近三個月平均 3 萬。');
  });
  it('POST 帶 CSRF 標頭與 JSON；error 事件變成 ApiError（帶狀態碼與中文訊息）', async () => {
    const f = vi.fn(async () => sse([ev('delta', { t: '到一半' }), ev('error', { status: 429, detail: '今日 AI 額度已用完' })]));
    vi.stubGlobal('fetch', f);
    await expect(apiSse('/ai/ask/stream', { question: 'q' }, () => undefined)).rejects.toMatchObject({ status: 429, message: '今日 AI 額度已用完' });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('t');
  });
  it('串流沒有以 done 結束（斷線）→ 丟錯，讓呼叫端顯示「回答中斷了」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([ev('delta', { t: 'abc' })])));
    await expect(apiSse('/ai/ask/stream', {}, () => undefined)).rejects.toMatchObject({ status: 502 });
  });
  it('開始串流前的錯誤是一般 JSON 回應（額度、格式）；瀏覽器沒有 body 時丟 StreamUnsupported 讓呼叫端改用一般版', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: '輸入資料格式錯誤' }), { status: 422 })));
    await expect(apiSse('/ai/ask/stream', {}, () => undefined)).rejects.toBeInstanceOf(ApiError);
    const noBody = { ok: true, status: 200, body: null, json: async () => null } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn(async () => noBody));
    await expect(apiSse('/ai/ask/stream', {}, () => undefined)).rejects.toBeInstanceOf(StreamUnsupported);
  });
  it('CSRF 失效（403 安全驗證）→ 重新取得後重送一次', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '安全驗證失敗，請重新整理頁面後再試' }), { status: 403 }))
      .mockResolvedValue(sse([ev('done', { answer: 'ok' })]));
    vi.stubGlobal('fetch', f);
    vi.stubGlobal('document', { cookie: 'csrf_token=t' });
    const r = await apiSse<{ answer: string }>('/ai/ask/stream', {}, () => undefined);
    expect(r.answer).toBe('ok');
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith('/ai/ask/stream')).length).toBe(2);
  });
  it('串流本體傳輸停發事件（idle）超過逾時時間 → abort 並丟出連線逾時 ApiError', async () => {
    let enqueueFn: ((chunk: Uint8Array) => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        enqueueFn = (chunk) => c.enqueue(chunk);
        enqueueFn(enc.encode(ev('delta', { t: '第一段' })));
      },
      cancel() {
        // cancel handler
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })));
    const seen: string[] = [];
    await expect(
      apiSse<{ answer: string }>(
        '/ai/ask/stream',
        {},
        (n, d) => { if (n === 'delta') seen.push((d as { t: string }).t); },
        true,
        30,
      ),
    ).rejects.toThrow('連線逾時，請檢查網路後重試');
    expect(seen).toEqual(['第一段']);
  });
});

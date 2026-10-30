import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { clearAiLog, loadAiLog, recordAiSend, redactForLog } from '@/services/aiLog';

describe('AI 送出紀錄', () => {
  beforeEach(async () => { await db.meta.clear(); });

  it('照片換成大小說明，其餘內容原樣留下', () => {
    const body = { image: `data:image/jpeg;base64,${'A'.repeat(4096)}`, categories: ['飲食'], today: '2026-10-31' };
    const s = redactForLog(body);
    expect(s).not.toContain('AAAA');
    expect(s).toContain('照片，約 3 KB，不留存');
    expect(s).toContain('飲食');
  });
  it('新的在前、最多 25 筆、可清除', async () => {
    for (let i = 0; i < 30; i++) await recordAiSend('/ai/ask', { question: `問題${i}` });
    const log = await loadAiLog();
    expect(log).toHaveLength(25);
    expect(log[0].payload).toContain('問題29');
    expect(log.at(-1)!.payload).toContain('問題5');
    await clearAiLog();
    expect(await loadAiLog()).toEqual([]);
  });
  it('過長內容會截斷並標示；送出的原文完整可看', async () => {
    await recordAiSend('/ai/insights', { summary: 'x'.repeat(30_000) });
    const [r] = await loadAiLog();
    expect(r.truncated).toBe(true);
    expect(r.payload.length).toBe(20_000);
    expect(r.bytes).toBeGreaterThan(30_000);
  });
});

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_WORKER_CODE, draftsFromItem, isStatementMail, SHORTCUTS, SOURCE_LABEL, type InboxRaw } from '@/services/inbox';
import { parseContext } from '@/services/quickentry';

const mail = (over: Partial<InboxRaw>): InboxRaw => ({ id: 1, source: 'email', text: '', amount: '', merchant: '玉山銀行', card: '', occurred: '', created_at: '2026-11-06T01:00:00', ...over });

describe('Email 轉寄收帳單（App 端）', () => {
  it('帳單信（有附件或本文像帳單）不會被當成一筆消費', async () => {
    expect(isStatementMail(mail({ text: '10 月信用卡電子帳單\n您本期應繳金額 NT$12,345' }))).toBe(true);
    expect(isStatementMail(mail({ text: '請見附件', attachments: [{ id: 1, filename: 's.csv', content_type: 'text/csv', size: 10 }] }))).toBe(true);
    expect(isStatementMail(mail({ source: 'sms', text: '電子帳單 應繳金額 NT$99' }))).toBe(false); // 簡訊不受影響
    expect(isStatementMail(mail({ text: '您於全家消費 NT$85' }))).toBe(false); // 消費通知信照常解析
    const ctx = await parseContext();
    expect(await draftsFromItem(mail({ text: '電子帳單：您本期應繳金額 NT$12,345' }), ctx, 'x')).toEqual([]);
  });

  it('捷徑模板有 6 個、每個都有對應的來源標籤與說明；Cloudflare Worker 程式碼會送整封信', () => {
    expect(SHORTCUTS.map((s) => s.key)).toEqual(['applepay', 'sms', 'siri', 'quick', 'clipboard', 'share']);
    for (const s of SHORTCUTS) { expect(s.hint.length).toBeGreaterThan(5); expect(s.name.startsWith('Aster')).toBe(true); }
    for (const k of ['clipboard', 'share', 'quick', 'email'] as const) expect(SOURCE_LABEL[k].label).toBeTruthy();
    expect(CLOUDFLARE_WORKER_CODE).toContain('message/rfc822');
    expect(CLOUDFLARE_WORKER_CODE).toContain('env.ASTER_TOKEN');
    expect(CLOUDFLARE_WORKER_CODE).not.toMatch(/clr_/); // 範例程式碼不能寫死權杖
  });
});

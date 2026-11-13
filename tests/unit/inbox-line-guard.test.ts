import { describe, expect, it } from 'vitest';
import { isLineChat, isTrustedLineNotice, judgeNotice } from '@/services/inbox';

const n = (card: string, text: string, source = 'notify') => ({ source, card, text, merchant: '' }) as Parameters<typeof judgeNotice>[0];

describe('LINE 誤記防護', () => {
  it('分辨 LINE 聊天與 LINE Pay／銀行 App', () => {
    expect(isLineChat('LINE')).toBe(true);
    expect(isLineChat('\nLINE')).toBe(true);
    expect(isLineChat('LINE Pay')).toBe(false);
    expect(isLineChat('LINE Bank')).toBe(false);
    expect(isLineChat('國泰世華')).toBe(false);
    expect(isLineChat('')).toBe(false);
  });

  it('朋友聊天提到金額不算官方通知', () => {
    expect(isTrustedLineNotice('晚餐 500 你先幫我付')).toBe(false);
    expect(isTrustedLineNotice('我剛用玉山刷了 1200')).toBe(false);
  });

  it('官方帳號的交易通知才放行', () => {
    expect(isTrustedLineNotice('【LINE Pay】您已於 全家 消費 NT$85，付款成功')).toBe(true);
    expect(isTrustedLineNotice('【國泰世華】您的信用卡於 7-ELEVEN 刷卡消費 120 元')).toBe(true);
    expect(isTrustedLineNotice('【國泰世華】本月帳單已產生')).toBe(false);
  });

  it('非官方 LINE：有金額 → 留在收件匣確認；沒金額 → 丟掉', () => {
    expect(judgeNotice(n('LINE', '晚餐 500 你先幫我付'), true).trust).toBe('review');
    expect(judgeNotice(n('LINE', '今天好冷喔'), false).trust).toBe('drop');
  });

  it('官方 LINE 通知與非 LINE 來源照舊', () => {
    expect(judgeNotice(n('LINE', '【LINE Pay】您已於 全家 消費 NT$85，付款成功'), true).trust).toBe('ok');
    expect(judgeNotice(n('LINE Pay', '付款 85 元'), true).trust).toBe('ok');
    expect(judgeNotice(n('國泰世華', '刷卡 120 元'), true).trust).toBe('ok');
    expect(judgeNotice(n('', '午餐 120', 'siri'), true).trust).toBe('ok');
  });
});

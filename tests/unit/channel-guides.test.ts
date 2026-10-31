import { describe, expect, it } from 'vitest';
import { GUIDES } from '@/features/settings/channelGuides';
import { KIND_INFO } from '@/services/outgoing';

describe('外部通知教學', () => {
  const kinds = Object.keys(KIND_INFO) as (keyof typeof KIND_INFO)[];
  it('四種通道都有完整教學：步驟、要貼的欄位、常見問題、官方連結', () => {
    expect(Object.keys(GUIDES).sort()).toEqual([...kinds].sort());
    for (const k of kinds) {
      const g = GUIDES[k];
      expect(g.steps.length, k).toBeGreaterThanOrEqual(3);
      expect(g.paste.length, k).toBeGreaterThanOrEqual(1);
      expect(g.troubleshoot.length, k).toBeGreaterThanOrEqual(2);
      expect(g.links.length, k).toBeGreaterThanOrEqual(1);
      expect(g.facts.some((f) => f.includes('難度')), k).toBe(true);
    }
  });
  it('連結全部是 https，且不含重複', () => {
    const urls = kinds.flatMap((k) => GUIDES[k].links.map((l) => l.url));
    expect(urls.every((u) => u.startsWith('https://'))).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
  });
  it('教學不含任何看起來像真實金鑰的字串', () => {
    const all = JSON.stringify(GUIDES);
    expect(/\d{9,}:[A-Za-z0-9_-]{30,}/.test(all)).toBe(false); // Telegram 權杖格式
    expect(/discord\.com\/api\/webhooks\/\d{15,}/.test(all)).toBe(false);
  });
  it('LINE 教學如實標示額度來源與不確定處，不把日本方案當成台灣官方數字', () => {
    const facts = GUIDES.line.facts.join('');
    expect(facts).toContain('台灣');
    expect(facts).toContain('官方');
    expect(facts).toContain('2025 年 3 月');
  });
});

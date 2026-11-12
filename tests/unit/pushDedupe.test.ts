import { describe, it, expect } from 'vitest';
import { tagToKind } from '@/services/pushDedupe';

describe('tagToKind 推播分類轉換', () => {
  it('inbox 推播標籤正確對應為 inbox kind', () => {
    expect(tagToKind('inbox:123')).toBe('inbox');
    expect(tagToKind('inbox:webhook-xyz')).toBe('inbox');
  });

  it('支援所有已知前綴', () => {
    expect(tagToKind('daily:2026-11-12')).toBe('daily_log');
    expect(tagToKind('card:card-1')).toBe('card_due');
    expect(tagToKind('budget:groceries')).toBe('budget');
    expect(tagToKind('sub:netflix')).toBe('subscription');
    expect(tagToKind('price:2330')).toBe('price_alert');
    expect(tagToKind('backup:2026-11-12')).toBe('backup');
    expect(tagToKind('sync:device-1')).toBe('sync');
    expect(tagToKind('insight:anomaly-1')).toBe('insight');
    expect(tagToKind('invoice:ab-12345678')).toBe('invoice');
  });

  it('未知前綴 fallback 至 daily_log', () => {
    expect(tagToKind('unknown:123')).toBe('daily_log');
    expect(tagToKind('')).toBe('daily_log');
  });
});

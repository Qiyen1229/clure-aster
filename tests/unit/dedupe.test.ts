import { describe, expect, it } from 'vitest';
import { dayGap, findDuplicate, normalizeShop, shopSimilar } from '@/domain/dedupe';

const tx = (over: Partial<{ id: string; date: string; amountMinor: number; currency: string; accountId: string; text: string }> = {}) =>
  ({ id: 't1', date: '2026-10-27', amountMinor: 12000, currency: 'TWD', accountId: 'a1', text: '全聯福利中心', ...over });

describe('去重：店名比對', () => {
  it('去掉通用字後比對', () => {
    expect(normalizeShop('全聯福利中心 刷卡 NT$120')).toBe('全聯福利中心');
    expect(shopSimilar('全聯', '全聯福利中心')).toBe(true);
    expect(shopSimilar('全聯福利中心', '全聯 板橋店')).toBe(true);
    expect(shopSimilar('全聯', '麥當勞')).toBe(false);
    expect(shopSimilar('', '麥當勞')).toBe(false);
  });
  it('日期差', () => {
    expect(dayGap('2026-10-31', '2026-11-01')).toBe(1);
    expect(dayGap('2026-10-27', '2026-10-27')).toBe(0);
  });
});

describe('去重：找重複的帳目', () => {
  const probe = { date: '2026-10-27', amountMinor: 12000, currency: 'TWD', accountId: 'a2', text: 'Apple Pay 全聯' };
  it('同一天、商家相近 → 很可能重複', () => {
    expect(findDuplicate(probe, [tx()])).toEqual({ id: 't1', level: 'strong' });
  });
  it('同一天、同帳戶、商家不同 → 很可能重複', () => {
    expect(findDuplicate({ ...probe, text: '', accountId: 'a1' }, [tx({ text: '午餐' })])).toEqual({ id: 't1', level: 'strong' });
  });
  it('同一天但商家與帳戶都不同 → 只是提醒', () => {
    expect(findDuplicate({ ...probe, text: '麥當勞' }, [tx()])).toEqual({ id: 't1', level: 'weak' });
  });
  it('相差 1 天 → 只是提醒；2 天以上不算', () => {
    expect(findDuplicate({ ...probe, date: '2026-10-28' }, [tx()])?.level).toBe('weak');
    expect(findDuplicate({ ...probe, date: '2026-10-29' }, [tx()])).toBeNull();
  });
  it('金額或幣別不同不算', () => {
    expect(findDuplicate(probe, [tx({ amountMinor: 12100 })])).toBeNull();
    expect(findDuplicate(probe, [tx({ currency: 'USD' })])).toBeNull();
  });
  it('多筆候選取最像的', () => {
    const r = findDuplicate(probe, [tx({ id: 'far', date: '2026-10-26', text: '麥當勞' }), tx({ id: 'near' })]);
    expect(r).toEqual({ id: 'near', level: 'strong' });
  });
});

import { computeSplit } from '@/features/add/SplitSheet';

describe('分帳：別人先付', () => {
  const people = [{ name: '小明', amount: '' }, { name: '小華', amount: '' }];
  it('我先付：平均分（含我），沒有 payer', () => {
    const r = computeSplit(30000, { mode: 'equal', people }, 'TWD');
    expect(r.myShare).toBe(10000);
    expect(r.shares.map((x) => x.minor)).toEqual([10000, 10000]);
    expect(r.error).toBeUndefined();
  });
  it('別人先付：要選到名單裡的人，份額照樣計算', () => {
    expect(computeSplit(30000, { mode: 'equal', people, payer: '' }, 'TWD').error).toBeTruthy();
    expect(computeSplit(30000, { mode: 'equal', people, payer: '路人' }, 'TWD').error).toBeTruthy();
    const r = computeSplit(30000, { mode: 'equal', people, payer: '小明' }, 'TWD');
    expect(r.error).toBeUndefined();
    expect(r.myShare).toBe(10000);
  });
  it('自訂金額：我的份額＝總額扣掉別人的', () => {
    const r = computeSplit(30000, { mode: 'custom', people: [{ name: '小明', amount: '150' }, { name: '小華', amount: '50' }], payer: '小明' }, 'TWD');
    expect(r.myShare).toBe(10000);
  });
});

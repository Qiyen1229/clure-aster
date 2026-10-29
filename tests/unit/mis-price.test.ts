import { describe, expect, it } from 'vitest';
import { misPrice } from '@/services/quotes/providers';

describe('證交所 MIS 最新價', () => {
  it('有成交價 z 就用 z', () => expect(misPrice({ z: '2400.0000', y: '2425' })).toBe('2400'));
  it('z 是 "-" 時用最後一筆成交 trade.z，不是最佳買價', () => {
    expect(misPrice({ z: '-', trade: { z: '2400.0000' }, a: '2400_2405_', b: '2395_2390_', y: '2425' })).toBe('2400');
  });
  it('沒有成交資料時用最佳買賣價中間值，再退回買價與昨收', () => {
    expect(misPrice({ z: '-', a: '2400_', b: '2390_', y: '2425' })).toBe('2395');
    expect(misPrice({ z: '-', a: '-', b: '2390_', y: '2425' })).toBe('2390');
    expect(misPrice({ z: '-', a: '-', b: '0', y: '2425' })).toBe('2425');
  });
});

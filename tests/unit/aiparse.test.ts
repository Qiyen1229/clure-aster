/**
 * v1.5：AI 解析結果對回使用者的分類／帳戶
 */
import { describe, expect, it } from 'vitest';
import { aiEntriesToDrafts, namesForAi, type AiEntry } from '@/domain/aiparse';
import type { ParseContext } from '@/domain/nlp';

const ctx: ParseContext = {
  today: '2026-10-28',
  accounts: [{ id: 'cash', name: '錢包' }, { id: 'esun', name: '玉山卡' }],
  categories: [
    { id: 'lunch', name: '午餐', kind: 'expense', parentId: 'food' },
    { id: 'salary', name: '薪資', kind: 'income', parentId: '' },
  ],
};
const e = (p: Partial<AiEntry>): AiEntry => ({ type: 'expense', amount: 100, note: '', category: null, account: null, to_account: null, date: null, ...p });

describe('aiEntriesToDrafts', () => {
  it('名稱對回 id，日期缺省為今天', () => {
    const [d] = aiEntriesToDrafts([e({ amount: 150, category: '午餐', account: '玉山卡', date: '2026-10-27', note: '便當' })], ctx, '昨天午餐');
    expect(d).toMatchObject({ kind: 'expense', amount: 150, categoryId: 'lunch', accountId: 'esun', date: '2026-10-27', dateGiven: true, note: '便當', raw: '昨天午餐' });
    const [n] = aiEntriesToDrafts([e({})], ctx, 'x');
    expect(n).toMatchObject({ date: '2026-10-28', dateGiven: false, categoryId: undefined, accountId: undefined });
  });

  it('分類種類要符合（收入不能用支出分類）', () => {
    const [d] = aiEntriesToDrafts([e({ type: 'income', category: '午餐' })], ctx, 'x');
    expect(d.categoryId).toBeUndefined();
    const [s] = aiEntriesToDrafts([e({ type: 'income', category: '薪資' })], ctx, 'x');
    expect(s.categoryId).toBe('salary');
  });

  it('轉帳需要兩個不同帳戶，否則丟棄', () => {
    expect(aiEntriesToDrafts([e({ type: 'transfer', account: '錢包', to_account: '玉山卡' })], ctx, 'x')).toHaveLength(1);
    expect(aiEntriesToDrafts([e({ type: 'transfer', account: '錢包' })], ctx, 'x')).toHaveLength(0);
    expect(aiEntriesToDrafts([e({ type: 'transfer', account: '錢包', to_account: '錢包' })], ctx, 'x')).toHaveLength(0);
  });

  it('金額不合理的丟棄；不認得的名稱留空', () => {
    const l = aiEntriesToDrafts([e({ amount: 0 }), e({ amount: -3 }), e({ category: '亂寫', account: '不存在' })], ctx, 'x');
    expect(l).toHaveLength(1);
    expect(l[0].categoryId).toBeUndefined();
    expect(l[0].accountId).toBeUndefined();
  });
});

describe('namesForAi', () => {
  it('只送名稱並去重、限制數量', () => {
    const many: ParseContext = { ...ctx, categories: Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, name: `分類${i % 150}`, kind: 'expense' as const, parentId: '' })) };
    const n = namesForAi(many);
    expect(n.categories).toHaveLength(120);
    expect(n.accounts).toEqual(['錢包', '玉山卡']);
    expect(JSON.stringify(n)).not.toContain('esun');
  });
});

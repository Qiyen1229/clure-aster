import { describe, expect, it } from 'vitest';
import { classifyExpense, habitHigh, judgeExpense, type JudgeInput } from '@/domain/pricing';

const yuan = (n: number) => n * 100;
/** 平常一筆約 120 元、很穩定的 20 筆 */
const usual = Array.from({ length: 20 }, (_, i) => yuan(100 + (i % 5) * 10));
const base = (o: Partial<JudgeInput> & { name?: string; main?: string; note?: string; amount: number }): JudgeInput => ({
  amountMinor: yuan(o.amount), others: o.others ?? usual, allMedian: yuan(120), allP95: yuan(600), marketOk: o.marketOk ?? true,
  cat: { name: o.name ?? '午餐', mainName: o.main ?? '飲食', note: o.note ?? '' },
});

describe('分類與行情', () => {
  it('小額日常支出有行情範圍；大額項目標為略過', () => {
    expect(classifyExpense({ name: '午餐', mainName: '飲食' })).toMatchObject({ cls: 'daily', range: [60, 300] });
    expect(classifyExpense({ name: '計程車', mainName: '交通' })).toMatchObject({ cls: 'daily' });
    expect(classifyExpense({ name: '3C 數位', mainName: '購物' }).cls).toBe('skip');
    expect(classifyExpense({ name: '家具家電', mainName: '居住' }).cls).toBe('skip');
    expect(classifyExpense({ name: '學費', mainName: '教育' }).cls).toBe('skip');
    expect(classifyExpense({ name: '旅遊', mainName: '娛樂' }).cls).toBe('skip');
    expect(classifyExpense({ name: '壽險', mainName: '保險' }).cls).toBe('skip');
    expect(classifyExpense({ name: '日用品', mainName: '居住' }).cls).toBe('daily'); // 居住底下的日用品是小額
    expect(classifyExpense({ name: '其他', mainName: '其他' }).cls).toBe('unknown');
  });
  it('備註寫明是大額項目：即使分類選「其他」「購物」也不提醒', () => {
    for (const note of ['買冰箱', '學雜費', '買車頭期款', '機票', '手機', '房租', '醫藥費 住院', '婚禮禮金']) {
      expect(classifyExpense({ name: '其他', mainName: '其他', note }).cls).toBe('skip');
    }
    // 「停車」不是「買車」：仍是小額日常
    expect(classifyExpense({ name: '停車', mainName: '交通', note: '停車費' }).cls).toBe('daily');
  });
});

describe('判斷這筆合不合理', () => {
  it('買家電、學雜費、買車：金額再大也不提醒', () => {
    expect(judgeExpense(base({ amount: 45000, name: '家具家電', main: '居住' }))).toMatchObject({ verdict: 'ok', basis: 'skip' });
    expect(judgeExpense(base({ amount: 38000, name: '學費', main: '教育' })).verdict).toBe('ok');
    expect(judgeExpense(base({ amount: 600000, name: '其他', main: '其他', note: '買車 頭期款' })).verdict).toBe('ok');
  });
  it('吃飯突然 5200 元：超出市價很多、也超出自己的習慣 → 提醒', () => {
    const j = judgeExpense(base({ amount: 5200 }));
    expect(j.verdict).toBe('high');
    expect(j.basis).toBe('market');
    expect(j.marketHigh).toBe(yuan(300 * 1.6));
    expect(j.habit!.median).toBe(yuan(120));
  });
  it('比平常貴、但還在市價範圍內：不提醒（例如平常吃 120，這次吃了一頓 450 的晚餐）', () => {
    expect(judgeExpense(base({ amount: 450, name: '晚餐' })).verdict).toBe('ok');
  });
  it('落在自己平常的範圍：不提醒（習慣本來就貴的人）', () => {
    const rich = Array.from({ length: 15 }, (_, i) => yuan(900 + i * 20));
    expect(judgeExpense(base({ amount: 1300, name: '晚餐', others: rich })).verdict).toBe('ok');
  });
  it('習慣資料不足（不到 8 筆）時只看市價', () => {
    expect(judgeExpense(base({ amount: 5200, others: [yuan(100), yuan(120)] })).verdict).toBe('high');
    expect(judgeExpense(base({ amount: 400, name: '晚餐', others: [] })).verdict).toBe('ok');
  });
  it('沒有行情資料的分類，比習慣高很多 → 判斷不了（unknown），交給外部判斷；離譜到極端才標示 extreme', () => {
    const j = judgeExpense(base({ amount: 600, name: '其他', main: '其他' }));
    expect(j.verdict).toBe('unknown');
    expect(j.extreme).toBe(false);
    expect(judgeExpense(base({ amount: 9000, name: '其他', main: '其他' })).extreme).toBe(true);
  });
  it('不是台幣：沒有行情表，只在比習慣高很多時才判斷不了', () => {
    expect(judgeExpense(base({ amount: 5200, marketOk: false })).verdict).toBe('unknown');
    expect(judgeExpense(base({ amount: 300, marketOk: false })).verdict).toBe('ok');
  });
  it('比一般消費小很多的金額一律不用想', () => {
    expect(judgeExpense(base({ amount: 200, name: '其他', main: '其他' })).verdict).toBe('ok');
  });
  it('習慣門檻：中位數 3 倍或中位數加 4 個穩健標準差，取大', () => {
    expect(habitHigh([100, 100, 100, 100]).high).toBe(300);
    expect(habitHigh([100, 300, 500, 700, 900]).high).toBeGreaterThan(1500); // 500 + 4×1.4826×200
  });
});

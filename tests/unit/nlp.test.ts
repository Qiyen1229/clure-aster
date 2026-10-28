/**
 * v1.3：一句話記帳的中文解析（金額、日期、帳戶、分類、一句多筆）
 */
import { describe, expect, it } from 'vitest';
import { extractDate, findAmounts, parseCnNumber, parseEntries, type ParseContext } from '@/domain/nlp';

const today = '2026-10-28'; // 週三
const ctx: ParseContext = {
  today,
  accounts: [
    { id: 'cash', name: '錢包', type: 'cash' },
    { id: 'esun', name: '玉山銀行', type: 'bank' },
    { id: 'taishin', name: '台新 Richart', type: 'bank' },
    { id: 'cube', name: '國泰 CUBE 卡', type: 'credit' },
    { id: 'ctbc', name: '中國信託', type: 'bank' },
  ],
  categories: [
    { id: 'food', name: '飲食', kind: 'expense', parentId: '' },
    { id: 'lunch', name: '午餐', kind: 'expense', parentId: 'food' },
    { id: 'breakfast', name: '早餐', kind: 'expense', parentId: 'food' },
    { id: 'drink', name: '飲料', kind: 'expense', parentId: 'food' },
    { id: 'dinner', name: '晚餐', kind: 'expense', parentId: 'food' },
    { id: 'taxi', name: '計程車', kind: 'expense', parentId: 'transport' },
    { id: 'salary', name: '薪資', kind: 'income', parentId: '' },
    { id: 'other', name: '其他', kind: 'expense', parentId: '' },
  ],
};

describe('中文數字', () => {
  it.each([
    ['150', 150], ['1,234', 1234], ['1.5', 1.5], ['一百五', 150], ['兩千三', 2300], ['一百零五', 105], ['十五', 15], ['二十', 20],
    ['3千2', 3200], ['5萬2', 52000], ['1.5萬', 15000], ['三萬二千', 32000], ['3k', 3000], ['１２０', 120],
  ])('%s → %d', (s, v) => expect(parseCnNumber(s)).toBe(v));
});

describe('找金額', () => {
  it('避開店名、數量、日期與時間', () => {
    expect(findAmounts('7-11 咖啡 45').map((a) => a.value)).toEqual([45]);
    expect(findAmounts('85度C 蛋糕 2個 120').map((a) => a.value)).toEqual([120]);
    expect(findAmounts('五十嵐 綠茶 50').map((a) => a.value)).toEqual([50]);
    expect(findAmounts('10/25 午餐 150').map((a) => a.value)).toEqual([150]);
    expect(findAmounts('下午3點 咖啡 80').map((a) => a.value)).toEqual([80]);
    expect(findAmounts('週3 午餐 一百五').map((a) => a.value)).toEqual([150]);
  });
  it('NT$、元、塊算有標記；中文數字要有單位或「元」', () => {
    const [a] = findAmounts('計程車 NT$230');
    expect(a).toMatchObject({ value: 230, marked: true });
    expect(findAmounts('三明治 五十元').map((a) => a.value)).toEqual([50]);
    expect(findAmounts('八方雲集 一蘭 三商')).toEqual([]);
    expect(findAmounts('十分好吃')).toEqual([]);
  });
});

describe('日期', () => {
  it.each([
    ['昨天午餐', '2026-10-27'], ['前天', '2026-10-26'], ['大前天', '2026-10-25'], ['3天前', '2026-10-25'],
    ['上週五', '2026-10-23'], ['週一', '2026-10-26'], ['週五', '2026-10-23'], ['這週三', '2026-10-28'],
    ['10/25', '2026-10-25'], ['12月25日', '2025-12-25'], ['25號', '2026-10-25'], ['30號', '2026-09-30'], ['2026/1/5', '2026-01-05'],
  ])('%s → %s', (s, d) => expect(extractDate(s, today).date).toBe(d));
  it('移除日期字樣', () => expect(extractDate('昨天 午餐', today).rest.trim()).toBe('午餐'));
});

describe('一句話記帳', () => {
  it('分類、帳戶、日期、備註', () => {
    const [d] = parseEntries('昨天午餐麥當勞 150 刷玉山卡', ctx);
    expect(d).toMatchObject({ kind: 'expense', amount: 150, date: '2026-10-27', accountId: 'esun', categoryId: 'lunch', note: '麥當勞' });
  });
  it('一句多筆，日期與帳戶套用到每一筆', () => {
    const list = parseEntries('昨天 早餐 60 午餐 120 飲料 55 都用現金', ctx);
    expect(list.map((x) => [x.amount, x.categoryId, x.date, x.accountId])).toEqual([
      [60, 'breakfast', '2026-10-27', 'cash'], [120, 'lunch', '2026-10-27', 'cash'], [55, 'drink', '2026-10-27', 'cash'],
    ]);
  });
  it('逗號分隔、中文數字', () => {
    const list = parseEntries('計程車兩百三，早餐 1,234', ctx);
    expect(list.map((x) => [x.amount, x.categoryId])).toEqual([[230, 'taxi'], [1234, 'breakfast']]);
  });
  it('收入', () => {
    const [d] = parseEntries('領薪水 5萬2 存到台新', ctx);
    expect(d).toMatchObject({ kind: 'income', amount: 52000, accountId: 'taishin' });
  });
  it('轉帳與提款', () => {
    expect(parseEntries('從玉山轉到台新 5000', ctx)[0]).toMatchObject({ kind: 'transfer', accountId: 'esun', toAccountId: 'taishin', amount: 5000 });
    expect(parseEntries('玉山提款 3000', ctx)[0]).toMatchObject({ kind: 'transfer', accountId: 'esun', toAccountId: 'cash' });
  });
  it('只有一張信用卡時「刷卡」對應到它；外幣', () => {
    expect(parseEntries('拉麵 1200 日圓 刷卡', ctx)[0]).toMatchObject({ amount: 1200, currency: 'JPY', accountId: 'cube' });
  });
  it('沒有金額就沒有結果', () => expect(parseEntries('今天好累', ctx)).toEqual([]));
});


describe('備註與分類辨識', () => {
  const one = (text: string, c: ParseContext = ctx) => parseEntries(text, c)[0];
  it('分類已經說了就不再寫進備註：只留具體的東西', () => {
    expect(one('今天早餐科學麵100塊')).toMatchObject({ amount: 100, categoryId: 'breakfast', note: '科學麵', date: today });
    expect(one('午餐麥當勞 150')).toMatchObject({ categoryId: 'lunch', note: '麥當勞' });
  });
  it('只說了分類：備註留空', () => {
    expect(one('晚餐320中國信託')).toMatchObject({ amount: 320, categoryId: 'dinner', accountId: 'ctbc', note: '' });
    expect(one('午餐 120')).toMatchObject({ categoryId: 'lunch', note: '' });
  });
  it('常見說法對應到分類：手搖飲 → 飲料', () => {
    expect(one('手搖飲230中國信託')).toMatchObject({ amount: 230, categoryId: 'drink', accountId: 'ctbc', note: '' });
    expect(one('買手搖飲 60')).toMatchObject({ categoryId: 'drink', note: '' });
  });
  it('具體的店名或品項只用來判斷分類，仍保留在備註', () => {
    expect(one('珍奶 65')).toMatchObject({ categoryId: 'drink', note: '珍奶' });
    expect(one('喝咖啡 80')).toMatchObject({ categoryId: 'drink', note: '咖啡' });
    expect(one('Uber 230')).toMatchObject({ categoryId: 'taxi', note: 'Uber' });
    expect(one('小黃 180')).toMatchObject({ categoryId: 'taxi', note: '' });
  });
  it('使用者沒有這個分類就不亂猜，備註照原樣', () => {
    const noDrink: ParseContext = { ...ctx, categories: ctx.categories.filter((c) => c.id !== 'drink') };
    expect(one('手搖飲 50', noDrink)).toMatchObject({ categoryId: undefined, note: '手搖飲' });
  });
  it('備註只剩動詞或贅字就當作沒有', () => {
    expect(one('吃 120')).toMatchObject({ note: '' });
    expect(one('吃科學麵 100')).toMatchObject({ note: '科學麵' });
  });
  it('收入：領到、收到不算備註', () => {
    expect(one('領薪水 5萬2 存到台新')).toMatchObject({ kind: 'income', categoryId: 'salary', note: '' });
    expect(one('收到小明還款 500')).toMatchObject({ kind: 'income', note: '小明還款' });
  });
  it('有標記的金額後面又說了一筆：兩筆都記', () => {
    const list = parseEntries('今天早餐科學麵100塊 手搖飲230', ctx);
    expect(list.map((x) => [x.amount, x.categoryId, x.note])).toEqual([[100, 'breakfast', '科學麵'], [230, 'drink', '']]);
    expect(parseEntries('咖啡 2 NT$120', ctx).map((x) => x.amount)).toEqual([120]);
  });
  it('一句多筆各自判斷', () => {
    const list = parseEntries('早餐蛋餅 60 手搖飲 55 晚餐 200', ctx);
    expect(list.map((x) => [x.amount, x.categoryId, x.note])).toEqual([[60, 'breakfast', '蛋餅'], [55, 'drink', ''], [200, 'dinner', '']]);
  });
});

describe('電話、帳號、網址不是金額', () => {
  it.each([
    ['電話 0912345678 消費 120 元', [120]],
    ['剛剛買了一杯手搖飲，電話 0912345678，會員編號 20261028123456', []],
    ['聯絡 02-2345-6789 午餐 150', [150]],
    ['詳情 https://bank.example.com/pay?id=123456 刷卡 NT$300', [300]],
    ['帳號 123456789012 轉入 5000', [5000]],
    ['午餐 1,234,567', [1234567]], // 有千分位的大金額不受影響
  ])('%s', (t, values) => {
    expect(findAmounts(t).map((h) => h.value)).toEqual(values);
  });
});

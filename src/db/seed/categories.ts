/**
 * 內建預設分類（兩層）。id 固定，方便深層連結：/add?category=food 會對應到 exp-food。
 * 格式：[key, 名稱, emoji, 顏色, 子分類[[key, 名稱, emoji]]]
 */
import type { Category, CategoryKind, SystemCategory } from '../types';

type Sub = [string, string, string];
type Main = [string, string, string, string, Sub[], SystemCategory?];

const EXPENSE: Main[] = [
  ['food', '飲食', '🍱', '#FF9F0A', [
    ['breakfast', '早餐', '🥪'], ['lunch', '午餐', '🍜'], ['dinner', '晚餐', '🍲'],
    ['snack', '點心', '🍰'], ['drink', '飲料', '🧋'], ['grocery', '食材', '🥬'], ['dineout', '聚餐', '🍻'],
  ]],
  ['clothing', '服飾', '👕', '#FF6482', [
    ['clothes', '衣物', '👚'], ['shoes', '鞋子', '👟'], ['accessory', '配件', '👜'], ['beauty', '美妝保養', '💄'], ['haircut', '美髮', '💇'],
  ]],
  ['housing', '居住', '🏠', '#AC8E68', [
    ['rent', '房租', '🔑'], ['mortgage', '房貸', '🏦'], ['utility', '水電瓦斯', '💡'], ['internet', '網路電信', '📶'],
    ['mgmt', '管理費', '🏢'], ['household', '日用品', '🧻'], ['furniture', '家具家電', '🛋️'], ['repair', '修繕', '🔧'],
  ]],
  ['transport', '交通', '🚇', '#0A84FF', [
    ['mrt', '捷運公車', '🚌'], ['taxi', '計程車', '🚕'], ['hsr', '高鐵火車', '🚄'], ['fuel', '加油', '⛽'],
    ['parking', '停車', '🅿️'], ['carcare', '保養維修', '🛠️'], ['flight', '機票', '✈️'], ['etc', 'ETC 過路', '🛣️'],
  ]],
  ['education', '教育', '📚', '#5E5CE6', [
    ['tuition', '學費', '🎓'], ['books', '書籍', '📖'], ['course', '課程', '🧑‍🏫'], ['exam', '考試證照', '📝'],
  ]],
  ['entertainment', '娛樂', '🎮', '#BF5AF2', [
    ['movie', '電影', '🎬'], ['game', '遊戲', '🕹️'], ['travel', '旅遊', '🧳'], ['hobby', '嗜好', '🎨'],
    ['sport', '運動健身', '🏋️'], ['music', '音樂演出', '🎤'],
  ]],
  ['medical', '醫療', '🩺', '#FF453A', [
    ['clinic', '門診', '🏥'], ['medicine', '藥品', '💊'], ['dental', '牙科', '🦷'], ['checkup', '健檢', '🩻'],
  ]],
  ['insurance', '保險', '🛡️', '#64D2FF', [
    ['life', '壽險', '❤️'], ['health', '醫療險', '🩹'], ['car_ins', '車險', '🚗'], ['nhi', '健保勞保', '🧾'],
  ]],
  ['pet', '寵物', '🐾', '#FFD60A', [
    ['petfood', '飼料', '🦴'], ['vet', '獸醫', '💉'], ['petgoods', '用品', '🧸'],
  ]],
  ['subscription', '訂閱', '🔁', '#30D158', [
    ['video', '影音串流', '📺'], ['musicsub', '音樂串流', '🎧'], ['cloud', '雲端軟體', '☁️'], ['membership', '會員', '🎫'],
  ]],
  ['social', '人情', '🎁', '#FF375F', [
    ['gift', '禮物', '🎁'], ['redenvelope', '紅白包', '🧧'], ['treat', '請客', '🍽️'], ['donation', '捐款', '🤲'],
  ]],
  ['shopping', '購物', '🛍️', '#FF9F0A', [
    ['digital', '3C 數位', '📱'], ['online', '網購', '📦'], ['daily', '雜貨', '🧺'],
  ]],
  ['family', '家庭', '👨‍👩‍👧', '#FFB340', [
    ['parents', '孝親', '👴'], ['kids', '育兒', '🍼'],
  ]],
  ['tax', '稅費', '🏛️', '#8E8E93', [
    ['incometax', '所得稅', '🧮'], ['housetax', '房屋地價稅', '🏘️'], ['cartax', '牌照燃料稅', '🚘'], ['bankfee', '銀行手續費', '🏦'],
  ]],
  ['investment_exp', '投資', '📈', '#FF453A', [
    ['stock_fee', '交易手續費', '🧾'],
  ]],
  ['other_exp', '其他', '✨', '#98989D', []],
];

const INCOME: Main[] = [
  ['salary', '薪資', '💼', '#30D158', [['base', '本薪', '💵'], ['overtime', '加班費', '⏰'], ['allowance', '津貼', '🎫']]],
  ['bonus', '獎金', '🏆', '#FFD60A', [['yearend', '年終', '🧧'], ['performance', '績效', '📊']]],
  ['interest', '利息', '🏦', '#64D2FF', [], 'interest'],
  ['dividend', '股利', '💰', '#FF9F0A', [], 'dividend'],
  ['investment_inc', '投資收益', '📈', '#FF453A', [['realized', '已實現損益', '💹']]],
  ['sidejob', '兼職外快', '🧑‍💻', '#5E5CE6', []],
  ['refund', '退款', '↩️', '#0A84FF', []],
  ['gift_inc', '禮金紅包', '🧧', '#FF375F', []],
  ['rent_inc', '租金收入', '🏘️', '#AC8E68', []],
  ['lottery', '中獎', '🎰', '#BF5AF2', []],
  ['other_inc', '其他', '✨', '#98989D', []],
];

/** 系統分類：餘額調整、轉帳手續費、股票買賣、借出／借入（隱藏於分類選擇器，但可在報表中看到） */
const SYSTEM: { id: string; kind: CategoryKind; name: string; icon: string; color: string; system: SystemCategory }[] = [
  { id: 'sys-adjust', kind: 'expense', name: '餘額調整', icon: '⚖️', color: '#8E8E93', system: 'adjust' },
  { id: 'sys-transfer-fee', kind: 'expense', name: '轉帳手續費', icon: '🔁', color: '#8E8E93', system: 'transfer_fee' },
  { id: 'sys-stock-buy', kind: 'expense', name: '股票買進', icon: '📈', color: '#FF453A', system: 'stock_buy' },
  { id: 'sys-stock-sell', kind: 'income', name: '股票賣出', icon: '💹', color: '#FF453A', system: 'stock_sell' },
  { id: 'sys-debt-out', kind: 'expense', name: '借出／還款', icon: '🤝', color: '#8E8E93', system: 'debt_out' },
  { id: 'sys-debt-in', kind: 'income', name: '借入／收款', icon: '🤝', color: '#8E8E93', system: 'debt_in' },
];

/** 每個主分類底下固定提供的「其他」子分類 */
export const OTHER_SUB_NAME = '其他';
export const OTHER_SUB_ICON = '✨';

export function buildDefaultCategories(now = Date.now()): Category[] {
  const out: Category[] = [];
  const push = (kind: CategoryKind, list: Main[]) => {
    const prefix = kind === 'expense' ? 'exp' : 'inc';
    list.forEach(([key, name, icon, color, subs, system], i) => {
      const id = `${prefix}-${key}`;
      out.push({ id, kind, parentId: '', name, icon, color, sort: i, archived: 0, system, createdAt: now, updatedAt: now });
      subs.forEach(([sk, sn, si], j) => {
        out.push({
          id: `${id}-${sk}`, kind, parentId: id, name: sn, icon: si, color, sort: j, archived: 0,
          system: sk === 'stock_fee' ? 'stock_fee' : undefined, createdAt: now, updatedAt: now,
        });
      });
    });
  };
  push('expense', EXPENSE);
  push('income', INCOME);
  SYSTEM.forEach((s, i) => out.push({ ...s, parentId: '', sort: 1000 + i, archived: 0, createdAt: now, updatedAt: now }));
  return out;
}

export const CATEGORY_COLORS = [
  '#FF453A', '#FF9F0A', '#FFD60A', '#30D158', '#63E6BE', '#64D2FF', '#0A84FF',
  '#5E5CE6', '#BF5AF2', '#FF375F', '#AC8E68', '#98989D',
];

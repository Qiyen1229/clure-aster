/**
 * 「這筆金額合不合理」的判斷規則（純函式，不使用 AI）。
 *
 * 不是金額大就有問題。判斷順序：
 *  1. 本來就是大額的項目（家電、3C、學費、買車、旅遊、醫療、保險、房租、人情…）：不提醒
 *     ——看分類，也看備註（備註寫了「買冰箱」「學雜費」「頭期款」，即使分類選「其他」也不提醒）
 *  2. 使用者自己的習慣：這個分類平常一筆多少？落在平常的範圍裡就不提醒
 *  3. 這個分類的一般市價（台幣，內建行情表）：吃飯、超商、交通這類小額日常支出，超出市價很多才提醒；
 *     沒超過市價上限就不提醒（即使比你平常貴）
 *  4. 判斷不了（分類沒有行情資料、又比平常高很多）：回傳 unknown，由呼叫端決定要不要請 AI 查市價
 * 行情表只在主幣別是台幣時使用；其他幣別只看習慣。
 */
import { median } from './anomaly-stats';

export type PriceClass = 'skip' | 'daily' | 'unknown';

export interface PriceInfo {
  cls: PriceClass;
  /** 一般「一次消費」的常見價格範圍（台幣，元）；只有 daily 才有 */
  range?: [number, number];
  /** 為什麼這樣分類（給白話說明與除錯） */
  why: string;
}

/** 備註裡出現這些字：本來就是大額的支出，不管分類選什麼都不提醒 */
const SKIP_NOTE = new RegExp([
  '家電', '冰箱', '洗衣機', '烘衣機', '電視', '冷氣', '空調', '熱水器', '吸塵器', '手機', '電腦', '筆電', '平板', '相機', '顯示器', '家具', '沙發', '床墊', '裝潢', '設計費',
  '學費', '學雜費', '註冊費', '補習', '才藝', '留學', '買車', '新車', '汽車', '機車', '車款', '頭期款', '訂金', '押金', '保費', '保險', '稅', '房貸', '房租', '租金', '貸款', '買房', '頭款',
  '旅遊', '旅行', '機票', '住宿', '飯店', '民宿', '行程', '出國', '手術', '住院', '醫藥費', '牙套', '植牙', '婚禮', '喜酒', '喜餅', '禮金', '白包', '紅包', '奠儀', '捐款', '投資', '股票', '基金',
].join('|'));

/** 小額日常支出的行情表：子分類名稱 → 一次消費的常見範圍（台幣，元）。範圍是「合理上限」的依據，不是平均 */
const DAILY: [RegExp, [number, number]][] = [
  [/早餐/, [30, 150]],
  [/午餐/, [60, 300]],
  [/晚餐/, [80, 600]],
  [/點心|零食|宵夜/, [30, 250]],
  [/飲料|咖啡|手搖/, [25, 150]],
  [/食材|買菜|超市|量販/, [50, 2000]],
  [/聚餐|請客|吃到飽|火鍋|燒肉/, [300, 3000]],
  [/捷運|公車|客運/, [15, 150]],
  [/計程車|uber|叫車/i, [85, 1000]],
  [/高鐵|火車|台鐵/, [50, 3500]],
  [/加油/, [200, 2000]],
  [/停車/, [20, 600]],
  [/etc|過路/i, [20, 400]],
  [/電影/, [150, 1000]],
  [/遊戲/, [30, 1500]],
  [/藥品|藥局|藥妝/, [30, 1500]],
  [/雜貨|日用品|超商/, [30, 2500]],
  [/美髮|剪髮|理髮/, [200, 3500]],
  [/飼料/, [100, 3000]],
];

/** 本來就是大額、或金額變動很大的項目：不做「大額異常」提醒 */
const SKIP_SUB = /家具|家電|3C|數位|旅遊|旅行|機票|牙科|健檢|保養維修|修繕|學費|課程|考試|房租|房貸|管理費|水電|網路|電信|壽險|醫療險|車險|健保|勞保|稅|投資|手續費|紅白包|捐款|孝親|育兒|禮物|運動健身|音樂演出|獸醫/;
const SKIP_MAIN = /^(居住|教育|醫療|保險|稅費|投資|家庭|人情|訂閱)$/;
/** 沒有細分類時，以主分類給一個寬鬆的範圍 */
const MAIN_DEFAULT: [RegExp, [number, number]][] = [
  [/^飲食$/, [40, 1500]],
  [/^交通$/, [15, 2500]],
];

export function classifyExpense(cat: { name: string; mainName: string; note?: string; merchant?: string }): PriceInfo {
  const text = `${cat.note ?? ''} ${cat.merchant ?? ''}`;
  if (SKIP_NOTE.test(text)) return { cls: 'skip', why: '備註寫明是大額項目' };
  for (const [re, range] of DAILY) if (re.test(cat.name)) return { cls: 'daily', range, why: `${cat.name}屬於小額日常支出` };
  if (SKIP_SUB.test(cat.name)) return { cls: 'skip', why: `${cat.name}本來就是大額或金額變動大的項目` };
  if (SKIP_MAIN.test(cat.mainName)) return { cls: 'skip', why: `${cat.mainName}類本來就是大額或金額變動大的項目` };
  for (const [re, range] of MAIN_DEFAULT) if (re.test(cat.mainName)) return { cls: 'daily', range, why: `${cat.mainName}屬於日常支出` };
  return { cls: 'unknown', why: '這個分類沒有行情資料' };
}

export interface JudgeInput {
  /** 這一筆（主幣別，最小單位） */
  amountMinor: number;
  cat: { name: string; mainName: string; note?: string; merchant?: string };
  /** 同主分類的其他帳目金額（不含這筆，最小單位）；用來看使用者自己的習慣 */
  others: number[];
  /** 全部支出的中位數與 P95（最小單位）：資料太少時判斷「這是不是突然的大額」 */
  allMedian: number;
  allP95: number;
  /** 主幣別是台幣才能用內建行情表 */
  marketOk: boolean;
}

export interface Judgment {
  verdict: 'ok' | 'high' | 'unknown';
  /** 判斷依據：skip＝大額項目、habit＝符合習慣、market＝依市價、none＝資料不足 */
  basis: 'skip' | 'habit' | 'market' | 'none';
  info: PriceInfo;
  /** 使用者習慣：平常一筆（中位數）與「超出才算突兀」的門檻（最小單位）；習慣資料不足時為 undefined */
  habit?: { median: number; high: number; n: number };
  /** 行情上限（最小單位）；沒有行情資料時為 undefined */
  marketHigh?: number;
  /** 判斷不了、而且已經離譜到不太可能是正常消費（可在沒有 AI 時當作 high） */
  extreme?: boolean;
}

/** 習慣的「突兀門檻」：中位數的 3 倍，或中位數加 4 個穩健標準差，取大者 */
export function habitHigh(values: number[]): { median: number; high: number } {
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  return { median: med, high: Math.max(med * 3, med + 4 * 1.4826 * mad) };
}

/** 超出市價上限的幾倍才算「過多」 */
export const MARKET_FACTOR = 1.6;
const MIN_HABIT = 8;

export function judgeExpense(i: JudgeInput): Judgment {
  const info = classifyExpense(i.cat);
  if (info.cls === 'skip') return { verdict: 'ok', basis: 'skip', info };
  // 比一般的消費小很多：不用想（沒資料時用全部支出的中位數當底）
  if (i.allMedian > 0 && i.amountMinor < i.allMedian * 3) return { verdict: 'ok', basis: 'none', info };

  const habit = i.others.length >= MIN_HABIT ? { ...habitHigh(i.others), n: i.others.length } : undefined;
  // 落在自己平常的範圍：不提醒
  if (habit && i.amountMinor <= habit.high) return { verdict: 'ok', basis: 'habit', info, habit };

  if (info.cls === 'daily' && info.range && i.marketOk) {
    const marketHigh = Math.round(info.range[1] * MARKET_FACTOR * 100);
    // 有行情：超出市價上限很多才提醒；沒超過就算比平常貴也正常
    return { verdict: i.amountMinor > marketHigh ? 'high' : 'ok', basis: 'market', info, habit, marketHigh };
  }
  if (info.cls === 'daily' && !i.marketOk) {
    // 非台幣：沒有行情表，只能看習慣；習慣不足就不判斷
    return habit && i.amountMinor >= habit.median * 10 ? { verdict: 'unknown', basis: 'none', info, habit, extreme: i.amountMinor >= habit.median * 20 } : { verdict: 'ok', basis: 'none', info, habit };
  }
  // 沒有行情資料的分類：比習慣高很多、或（習慣不足時）比全部支出高很多，才需要進一步判斷
  if (habit) return { verdict: 'unknown', basis: 'none', info, habit, extreme: i.amountMinor >= habit.median * 12 && i.amountMinor >= i.allP95 * 1.5 };
  return i.allMedian > 0 && i.amountMinor >= Math.max(i.allMedian * 8, i.allP95 * 1.5)
    ? { verdict: 'unknown', basis: 'none', info, extreme: false }
    : { verdict: 'ok', basis: 'none', info };
}

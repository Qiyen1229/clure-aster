/**
 * 預算預警（純函式，規則計算，不使用 AI）。
 *
 * 和既有的「已用 80%／已超支」提醒不同，這裡是「還沒超支，但照目前的花法會超支」的提早提醒：
 *  - early：預計期末花費超過額度（100%～120%），而且目前用量還不到 90%
 *  - critical：已用 90% 以上、或預計超過額度 20% 以上
 *  - over：已經超支
 * 預計期末花費沿用 domain/budget.projectSpend（有歷史就參考過去各期同一天之後的花費節奏）。
 * 每個預警附白話說明：預計哪天用完、每天最多還能花多少才守得住。
 */
import { eachDay, fromDateKey, addDays, type DateKey, type Range } from './period';

export type WarnLevel = 'early' | 'critical' | 'over';

export interface BudgetLite {
  id: string;
  name: string;
  /** 本期額度（含結轉） */
  limit: number;
  spent: number;
  period: Range;
  today: DateKey;
  /** 預計期末花費（BudgetView.projection.projected） */
  projected: number;
}

export interface BudgetWarning {
  /** 同一個預算、同一期、同一等級只提醒一次 */
  id: string;
  budgetId: string;
  name: string;
  level: WarnLevel;
  title: string;
  why: string;
  tip: string;
  limit: number;
  spent: number;
  projected: number;
  /** 照目前速度預計用完的日子（用不完或已超支則沒有） */
  exhaustDate?: DateKey;
  /** 剩下的日子，每天最多還能花多少才不會超支 */
  dailyCap: number;
}

const LEVEL_RANK: Record<WarnLevel, number> = { over: 0, critical: 1, early: 2 };
const md = (d: DateKey) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export function forecastBudget(b: BudgetLite, fmt: (minor: number) => string): BudgetWarning | null {
  if (b.limit <= 0 || b.today < b.period.start || b.today > b.period.end) return null;
  const total = eachDay(b.period).length;
  const elapsed = eachDay({ start: b.period.start, end: b.today }).length;
  const daysLeft = total - elapsed; // 今天之後還剩幾天
  const remaining = b.limit - b.spent;
  const pct = (b.spent / b.limit) * 100;
  const base = { id: `bw:${b.id}`, budgetId: b.id, name: b.name, limit: b.limit, spent: b.spent, projected: b.projected };

  if (b.spent > b.limit) {
    const over = b.spent - b.limit;
    return {
      ...base, id: `${base.id}:${b.period.start}:over`, level: 'over', dailyCap: 0,
      title: `「${b.name}」已超支 ${fmt(over)}`,
      why: `本期額度 ${fmt(b.limit)}，目前已經花了 ${fmt(b.spent)}，超出 ${fmt(over)}（${Math.round((over / b.limit) * 100)}%）。${daysLeft > 0 ? `離這一期結束還有 ${daysLeft} 天` : '這一期今天結束'}。`,
      tip: daysLeft > 0 ? '剩下的日子盡量不要再花這一項；如果這個額度本來就抓太低，可以到預算頁調整。' : '下一期可以參考這次的花費重新調整額度。',
    };
  }
  // 期間剛開始、或還沒花多少：預測不準，不打擾
  if (elapsed < 3 || b.spent <= 0 || daysLeft <= 0) return null;
  const pace = b.spent / elapsed;
  const exhaust = pace > 0 ? Math.floor(remaining / pace) : Infinity; // 還能撐幾天
  const exhaustDate = exhaust < daysLeft ? addDays(b.today, exhaust) : undefined;
  const dailyCap = Math.max(0, Math.floor(remaining / daysLeft));
  const ratio = b.projected / b.limit;
  const level: WarnLevel | null = pct >= 90 || ratio >= 1.2 ? 'critical' : ratio > 1 ? 'early' : pct >= 85 ? 'critical' : null;
  if (!level) return null;

  const paceText = `目前平均每天花約 ${fmt(Math.round(pace))}`;
  const when = exhaustDate ? `照這個速度，大約 ${md(exhaustDate)} 就會用完` : `照這個速度，這一期結束前會用完`;
  return {
    ...base, id: `${base.id}:${b.period.start}:${level}`, level, exhaustDate, dailyCap,
    title: level === 'critical' ? `「${b.name}」快不夠用了（已用 ${Math.round(pct)}%）` : `「${b.name}」照目前的花法會超支`,
    why: `本期額度 ${fmt(b.limit)}，已經花了 ${fmt(b.spent)}（${Math.round(pct)}%），還剩 ${fmt(remaining)}、${daysLeft} 天。${paceText}，${when}，預計期末會花到 ${fmt(b.projected)}（額度的 ${Math.round(ratio * 100)}%）。`,
    tip: dailyCap > 0 ? `接下來每天最多花 ${fmt(dailyCap)}，就能守住這一期的額度。` : '這一期剩下的額度已經很少，建議暫停這一項的花費。',
  };
}

/** 全部預算的預警：依嚴重程度排序（over → critical → early），同等級看超出比例 */
export function forecastAll(items: BudgetLite[], fmt: (minor: number) => string): BudgetWarning[] {
  return items
    .map((b) => forecastBudget(b, fmt))
    .filter((w): w is BudgetWarning => !!w)
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.projected / b.limit - a.projected / a.limit);
}

/** 期間內剩幾天（含今天以外）——給 UI 顯示用 */
export const daysUntil = (from: DateKey, to: DateKey) => Math.round((fromDateKey(to).getTime() - fromDateKey(from).getTime()) / 86400000);

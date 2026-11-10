/**
 * 分期付款攤還表。
 * - 年利率 0：本金以最大餘數法平均分攤（總和保證等於本金）
 * - 年利率 > 0：本息平均攤還（月利率 = 年利率 / 12），每期利息四捨五入，最後一期吃掉本金尾差
 * - 手續費：first = 第一期一次收取；spread = 平均分攤到每期
 */
import Decimal from 'decimal.js';
import { allocate, convertMinor } from './money';
import { addMonths, todayKey, type DateKey } from './period';
import type { InstallmentScheduleItem } from '@/db/types';

export function buildSchedule(params: {
  principalMinor: number;
  periods: number;
  aprDec: string;
  feeMinor: number;
  feeMode: 'first' | 'spread';
  firstDate: DateKey;
}): InstallmentScheduleItem[] {
  const { principalMinor: P, periods: n, aprDec, feeMinor, feeMode, firstDate } = params;
  if (n < 1 || !Number.isInteger(n)) throw new RangeError('期數需為正整數');
  if (P <= 0) throw new RangeError('本金需大於 0');
  const fees = feeMode === 'spread' ? allocate(feeMinor, Array(n).fill(1)) : [feeMinor, ...Array(n - 1).fill(0)];
  const r = new Decimal(aprDec || 0).div(100).div(12);
  const items: InstallmentScheduleItem[] = [];
  if (r.isZero()) {
    const parts = allocate(P, Array(n).fill(1));
    for (let k = 0; k < n; k++) items.push({ no: k + 1, date: addMonths(firstDate, k), principalMinor: parts[k], interestMinor: 0, feeMinor: fees[k] });
    return items;
  }
  // 每期應繳 = P·r / (1 − (1+r)^−n)
  const pay = new Decimal(P).mul(r).div(new Decimal(1).minus(r.plus(1).pow(-n)));
  let balance = new Decimal(P);
  for (let k = 0; k < n; k++) {
    const interest = balance.mul(r).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    let principal = pay.minus(interest).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    if (k === n - 1) principal = balance; // 最後一期結清
    balance = balance.minus(principal);
    items.push({ no: k + 1, date: addMonths(firstDate, k), principalMinor: principal.toNumber(), interestMinor: interest.toNumber(), feeMinor: fees[k] });
  }
  return items;
}

export const periodTotal = (it: InstallmentScheduleItem) => it.principalMinor + it.interestMinor + it.feeMinor;

/** 剩餘期數與未來負擔（尚未入帳的期數） */
export function remaining(schedule: InstallmentScheduleItem[]) {
  const left = schedule.filter((s) => !s.transactionId);
  return { periodsLeft: left.length, futureMinor: left.reduce((a, s) => a + periodTotal(s), 0) };
}

export interface InstallmentSummary {
  futureMinor: number;
  nextMonthDueMinor: number;
  missingRates: boolean;
}

/**
 * 跨幣別彙總進行中的分期未來總負擔與下個月應繳，缺匯率之分期不計入並標記 missingRates
 */
export function computeInstallmentSummary(
  list: Array<{ currency: string; status: string; schedule: InstallmentScheduleItem[] }>,
  base: string,
  resolveFx: (from: string, to: string) => Decimal.Value | null,
  nextMonth = addMonths(todayKey(), 1).slice(0, 7),
): InstallmentSummary {
  let futureMinor = 0;
  let nextMonthDueMinor = 0;
  let missingRates = false;

  for (const i of list) {
    const cur = i.currency;
    const r = cur === base ? 1 : resolveFx(cur, base);
    if (cur !== base && (r == null || r === '')) {
      missingRates = true;
      continue;
    }
    const rateVal = r ?? 1;

    if (i.status === 'active') {
      const rem = remaining(i.schedule).futureMinor;
      futureMinor += cur === base ? rem : convertMinor(rem, cur, base, rateVal);
    }

    for (const s of i.schedule) {
      if (!s.transactionId && s.date.startsWith(nextMonth)) {
        const due = periodTotal(s);
        nextMonthDueMinor += cur === base ? due : convertMinor(due, cur, base, rateVal);
      }
    }
  }

  return { futureMinor, nextMonthDueMinor, missingRates };
}

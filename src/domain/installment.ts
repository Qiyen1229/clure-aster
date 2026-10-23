/**
 * 分期付款攤還表。
 * - 年利率 0：本金以最大餘數法平均分攤（總和保證等於本金）
 * - 年利率 > 0：本息平均攤還（月利率 = 年利率 / 12），每期利息四捨五入，最後一期吃掉本金尾差
 * - 手續費：first = 第一期一次收取；spread = 平均分攤到每期
 */
import Decimal from 'decimal.js';
import { allocate } from './money';
import { addMonths, type DateKey } from './period';
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

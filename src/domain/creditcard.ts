/**
 * 信用卡帳單週期。結帳日 statementDay（例：每月 20 日），繳款日 dueDay（例：隔月 5 日）。
 * 本期帳單 = 上上次結帳日隔天 ～ 上次結帳日；未出帳 = 上次結帳日隔天 ～ 下次結帳日。
 */
import { addDays, daysInMonth, fromDateKey, toDateKey, type DateKey, type Range } from './period';

function statementDate(year: number, month0: number, day: number): DateKey {
  const y = year + Math.floor(month0 / 12);
  const m = ((month0 % 12) + 12) % 12;
  return toDateKey(new Date(y, m, Math.min(day, daysInMonth(y, m))));
}

export interface CreditCycle {
  /** 已出帳週期 */
  lastStatement: Range;
  /** 尚未出帳週期（含今天） */
  current: Range;
  /** 本期帳單繳款截止日 */
  dueDate: DateKey;
}

export function creditCycle(today: DateKey, statementDay: number, dueDay: number): CreditCycle {
  const d = fromDateKey(today);
  const y = d.getFullYear();
  const m = d.getMonth();
  // 最近一個「已過（含今天）」的結帳日
  let lastClose = statementDate(y, m, statementDay);
  let k = 0;
  if (lastClose > today) { lastClose = statementDate(y, m - 1, statementDay); k = -1; }
  const prevClose = statementDate(y, m + k - 1, statementDay);
  const nextClose = statementDate(y, m + k + 1, statementDay);
  // 繳款日：結帳日之後第一個 dueDay
  const lc = fromDateKey(lastClose);
  let due = statementDate(lc.getFullYear(), lc.getMonth(), dueDay);
  if (due <= lastClose) due = statementDate(lc.getFullYear(), lc.getMonth() + 1, dueDay);
  return {
    lastStatement: { start: addDays(prevClose, 1), end: lastClose },
    current: { start: addDays(lastClose, 1), end: nextClose },
    dueDate: due,
  };
}

export interface CreditAvailability {
  /** 目前欠款（已出帳未繳 + 未出帳） */
  owedMinor: number;
  /** 已出帳但尚未繳清 */
  billedUnpaidMinor: number;
  /** 本期未出帳消費 */
  unbilledMinor: number;
  /** 分期中「尚未入帳」的本金：銀行會先圈存在額度內 */
  installmentReservedMinor: number;
  usedMinor: number;
  availableMinor: number;
  usagePct: number;
}

/**
 * 信用卡額度佔用：可用額度 = 總額度 − 目前欠款（已出帳未繳 + 未出帳）− 未到期分期本金。
 * 用「目前欠款」而非只用「未出帳」，避免已出帳但還沒繳的帳單被當成可用額度。
 * balanceMinor 為帳戶餘額（信用卡欠款為負數）；unbilledMinor 為本期未出帳淨消費（正數）。
 */
export function creditAvailability(limitMinor: number, balanceMinor: number, unbilledMinor: number, installmentReservedMinor: number): CreditAvailability {
  const owed = Math.max(0, -balanceMinor);
  const unbilled = Math.min(owed, Math.max(0, unbilledMinor));
  const used = owed + Math.max(0, installmentReservedMinor);
  return {
    owedMinor: owed,
    billedUnpaidMinor: owed - unbilled,
    unbilledMinor: unbilled,
    installmentReservedMinor: Math.max(0, installmentReservedMinor),
    usedMinor: used,
    availableMinor: limitMinor - used,
    usagePct: limitMinor > 0 ? (used / limitMinor) * 100 : 0,
  };
}

/**
 * 貸款攤還（本息平均攤還，與分期共用 buildSchedule）：
 * - 依今天日期找出「已到期期數」，攤還表上應剩餘的本金
 * - 實際欠款（帳戶餘額）低於應剩餘本金代表有提前還款
 * - 剩餘利息、預計還清日、下一期
 */
import type { InstallmentScheduleItem, LoanInfo } from '@/db/types';
import { buildSchedule } from './installment';

export const LOAN_KIND_LABEL: Record<LoanInfo['kind'], string> = {
  mortgage: '房貸', car: '車貸', personal: '信貸', student: '學貸', other: '其他貸款',
};

export interface LoanStatus {
  schedule: InstallmentScheduleItem[];
  /** 每期應繳（第一期，本息平均時各期相同） */
  paymentMinor: number;
  paidPeriods: number;
  /** 依攤還表，今天應剩餘的本金 */
  scheduledBalanceMinor: number;
  /** 實際欠款（正數） */
  actualBalanceMinor: number;
  /** 提前還款金額（實際比應剩少的部分） */
  prepaidMinor: number;
  remainingInterestMinor: number;
  next?: InstallmentScheduleItem;
  payoffDate: string;
}

export function loanStatus(loan: LoanInfo, balanceMinor: number, today: string): LoanStatus | null {
  if (!(loan.principalMinor > 0) || !(loan.termMonths > 0) || !loan.firstPaymentDate) return null;
  const schedule = buildSchedule({ principalMinor: loan.principalMinor, periods: loan.termMonths, aprDec: loan.aprDec || '0', feeMinor: 0, feeMode: 'first', firstDate: loan.firstPaymentDate });
  const paid = schedule.filter((s) => s.date <= today);
  const scheduledBalanceMinor = loan.principalMinor - paid.reduce((a, s) => a + s.principalMinor, 0);
  const actual = Math.max(0, -balanceMinor);
  const future = schedule.slice(paid.length);
  return {
    schedule,
    paymentMinor: schedule[0].principalMinor + schedule[0].interestMinor,
    paidPeriods: paid.length,
    scheduledBalanceMinor,
    actualBalanceMinor: actual,
    prepaidMinor: Math.max(0, scheduledBalanceMinor - actual),
    remainingInterestMinor: future.reduce((a, s) => a + s.interestMinor, 0),
    next: future[0],
    payoffDate: schedule[schedule.length - 1].date,
  };
}

/**
 * 依「實際欠款」拆分這一期的還款：利息 = 欠款 × 月利率，其餘為本金（不超過欠款）。
 * 提前還款後利息會跟著變少，比照銀行實際計算。
 */
export function splitPayment(balanceMinor: number, aprDec: string, paymentMinor: number): { principalMinor: number; interestMinor: number } {
  const owed = Math.max(0, -balanceMinor);
  const interest = Math.round((owed * Number(aprDec || 0)) / 100 / 12);
  const principal = Math.max(0, Math.min(owed, paymentMinor - interest));
  return { principalMinor: principal, interestMinor: Math.min(interest, paymentMinor) };
}

// ───────────── 提前還款試算 ─────────────

export interface AmortResult { months: number; interestMinor: number; paymentMinor: number }

/** 固定月付逐月攤還：回傳還清月數與總利息；月付不夠付利息（永遠還不完）回傳 null */
export function amortize(balanceMinor: number, aprDec: string, paymentMinor: number, maxMonths = 1200): AmortResult | null {
  const r = Number(aprDec || 0) / 100 / 12;
  let b = Math.max(0, balanceMinor);
  let interest = 0;
  let months = 0;
  while (b > 0) {
    if (++months > maxMonths) return null;
    const i = Math.round(b * r);
    const pay = Math.min(paymentMinor, b + i);
    if (pay - i <= 0) return null;
    interest += i;
    b = b + i - pay;
  }
  return { months, interestMinor: interest, paymentMinor };
}

/** 在剩餘期數不變下，把 balance 還清所需的月付（本息平均） */
export function paymentFor(balanceMinor: number, aprDec: string, months: number): number {
  if (balanceMinor <= 0 || months <= 0) return 0;
  const r = Number(aprDec || 0) / 100 / 12;
  return Math.round(r === 0 ? balanceMinor / months : (balanceMinor * r) / (1 - (1 + r) ** -months));
}

export interface PrepaymentSim {
  baseline: AmortResult;
  /** 一次還款後月付不變（縮短年限） */
  shorten?: AmortResult & { savedInterestMinor: number; savedMonths: number };
  /** 一次還款後年限不變（降低月付） */
  lowerPayment?: AmortResult & { savedInterestMinor: number; paymentDropMinor: number };
  /** 每月多還（縮短年限） */
  extra?: AmortResult & { savedInterestMinor: number; savedMonths: number };
}

/**
 * 提前還款試算（不動任何資料）：以「實際欠款」「目前月付」為基準，比較
 *  - 一次還款 lumpMinor：A 月付不變、縮短年限；B 年限不變、降低月付
 *  - 每月多還 extraMonthlyMinor：縮短年限
 * 利息以月利率逐月計算（與 splitPayment 一致）。基準無法還清（月付不夠付利息）回傳 null。
 */
export function simulatePrepayment(input: { balanceMinor: number; aprDec: string; paymentMinor: number; lumpMinor?: number; extraMonthlyMinor?: number }): PrepaymentSim | null {
  const { balanceMinor, aprDec, paymentMinor } = input;
  const baseline = amortize(balanceMinor, aprDec, paymentMinor);
  if (!baseline) return null;
  const out: PrepaymentSim = { baseline };
  const lump = Math.min(Math.max(0, input.lumpMinor ?? 0), balanceMinor);
  if (lump > 0) {
    const after = balanceMinor - lump;
    const a = amortize(after, aprDec, paymentMinor);
    if (a) out.shorten = { ...a, savedInterestMinor: baseline.interestMinor - a.interestMinor, savedMonths: baseline.months - a.months };
    if (after > 0) {
      const pay = paymentFor(after, aprDec, baseline.months);
      const b = amortize(after, aprDec, pay);
      if (b) out.lowerPayment = { ...b, savedInterestMinor: baseline.interestMinor - b.interestMinor, paymentDropMinor: paymentMinor - pay };
    }
  }
  const extra = Math.max(0, input.extraMonthlyMinor ?? 0);
  if (extra > 0) {
    const c = amortize(balanceMinor, aprDec, paymentMinor + extra);
    if (c) out.extra = { ...c, savedInterestMinor: baseline.interestMinor - c.interestMinor, savedMonths: baseline.months - c.months };
  }
  return out;
}

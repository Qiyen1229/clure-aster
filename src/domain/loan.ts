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

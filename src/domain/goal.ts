/**
 * 存錢目標：進度、剩餘月數、每月需存金額。
 */
import { fromDateKey, type DateKey } from './period';

export function monthsBetween(from: DateKey, to: DateKey): number {
  const a = fromDateKey(from);
  const b = fromDateKey(to);
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() >= a.getDate()) m += 1; // 含當月
  return Math.max(0, m);
}

export function goalProgress(targetMinor: number, savedMinor: number, today: DateKey, deadline?: DateKey) {
  const pct = targetMinor > 0 ? Math.min(100, Math.max(0, (savedMinor / targetMinor) * 100)) : 0;
  const left = Math.max(0, targetMinor - savedMinor);
  const monthsLeft = deadline ? monthsBetween(today, deadline) : null;
  const monthly = monthsLeft === null ? null : monthsLeft <= 0 ? left : Math.ceil(left / monthsLeft);
  return { pct, left, monthsLeft, monthly, done: savedMinor >= targetMinor && targetMinor > 0, overdue: !!deadline && deadline < today && savedMinor < targetMinor };
}

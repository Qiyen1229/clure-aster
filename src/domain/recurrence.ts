/**
 * 週期規則展開（RRULE 子集）：每 N 日／週（可指定星期幾）／月（可指定日，月底夾住或略過）／年。
 * 以 startDate 為錨點，所有計算皆為純函式。
 */
import type { RecurrenceRule } from '@/db/types';
import { addDays, addMonths, daysInMonth, fromDateKey, toDateKey, weekRange, type DateKey } from './period';

/** 第 k 次（從 0 起算）的「月／年」型發生日；若該月沒有這天且 policy=skip 則回傳 null */
function monthlyAt(start: DateKey, rule: RecurrenceRule, k: number): DateKey | null {
  const months = (rule.freq === 'year' ? 12 : 1) * rule.interval * k;
  const s = fromDateKey(start);
  const target = new Date(s.getFullYear(), s.getMonth() + months, 1);
  const want = rule.byMonthDay ?? s.getDate();
  const dim = daysInMonth(target.getFullYear(), target.getMonth());
  if (want > dim && rule.monthEndPolicy === 'skip') return null;
  target.setDate(Math.min(want, dim));
  return toDateKey(target);
}

/** 產生 [from, to] 區間內的發生日（含 start 之後，受 until/count 限制） */
export function occurrences(rule: RecurrenceRule, start: DateKey, from: DateKey, to: DateKey, max = 1000): DateKey[] {
  const out: DateKey[] = [];
  const interval = Math.max(1, rule.interval || 1);
  const r = { ...rule, interval };
  let n = 0; // 已發生次數（自 start 起），用於 count
  const push = (d: DateKey) => {
    if (r.until && d > r.until) return false;
    if (r.count && n >= r.count) return false;
    n++;
    if (d >= from && d <= to) out.push(d);
    return d <= to && out.length < max;
  };
  if (r.freq === 'day') {
    for (let k = 0; ; k++) if (!push(addDays(start, k * interval))) break;
  } else if (r.freq === 'week') {
    const days = (r.byWeekday?.length ? [...r.byWeekday] : [fromDateKey(start).getDay()]).sort();
    const w0 = weekRange(start, 0).start;
    outer: for (let k = 0; ; k++) {
      const ws = addDays(w0, 7 * interval * k);
      for (const wd of days) {
        const d = addDays(ws, wd);
        if (d < start) continue;
        if (!push(d)) break outer;
      }
      if (k > 5000) break;
    }
  } else {
    for (let k = 0; k < 5000; k++) {
      const d = monthlyAt(start, r, k);
      if (d === null) continue;
      if (d < start) continue;
      if (!push(d)) break;
    }
  }
  return out;
}

/** start 之後、嚴格晚於 after 的下一次發生日；沒有則 null */
export function nextAfter(rule: RecurrenceRule, start: DateKey, after: DateKey): DateKey | null {
  const horizon = addMonths(after, 12 * Math.max(1, rule.interval || 1) + 1);
  const list = occurrences(rule, start, addDays(after, 1), horizon, 1);
  return list[0] ?? null;
}

/** 一年內的發生次數（用於「年度訂閱總花費」） */
export function timesPerYear(rule: RecurrenceRule): number {
  const i = Math.max(1, rule.interval || 1);
  switch (rule.freq) {
    case 'day': return 365 / i;
    case 'week': return (52 / i) * Math.max(1, rule.byWeekday?.length ?? 1);
    case 'month': return 12 / i;
    case 'year': return 1 / i;
  }
}

export function describeRule(rule: RecurrenceRule): string {
  const i = Math.max(1, rule.interval || 1);
  const W = ['日', '一', '二', '三', '四', '五', '六'];
  switch (rule.freq) {
    case 'day': return i === 1 ? '每天' : `每 ${i} 天`;
    case 'week': return `${i === 1 ? '每週' : `每 ${i} 週`}${rule.byWeekday?.length ? ' ' + rule.byWeekday.map((d) => `週${W[d]}`).join('、') : ''}`;
    case 'month': return `${i === 1 ? '每月' : `每 ${i} 個月`}${rule.byMonthDay ? ` ${rule.byMonthDay} 日` : ''}`;
    case 'year': return i === 1 ? '每年' : `每 ${i} 年`;
  }
}

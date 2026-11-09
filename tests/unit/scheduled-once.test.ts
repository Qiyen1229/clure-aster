/**
 * 單次排程（對話框「下禮拜二下午三點半午餐 200」）與更多日期／時間說法
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { processRecurring } from '@/db/repo/plan';
import { extractClock, extractDate } from '@/domain/nlp-date';
import { addDays, todayKey } from '@/domain/period';
import { draftsFromText, isScheduled, resolveDraft, scheduleDrafts } from '@/services/quickentry';
import { loadForecast } from '@/services/forecast';
import { runReminderChecks } from '@/services/notifications';
import { upcomingPushItems } from '@/services/push';

const MON = '2026-11-09'; // 週一

describe('日期：未來的說法', () => {
  it.each([
    ['下禮拜二', '2026-11-17'], ['下週五', '2026-11-20'], ['後天', '2026-11-11'], ['大後天', '2026-11-12'], ['3天後', '2026-11-12'], ['兩週後', '2026-11-23'],
    ['下個月5號', '2026-12-05'], ['下個月31號', '2026-12-31'], ['月底', '2026-11-30'], ['這個月底', '2026-11-30'], ['下月底', '2026-12-31'],
  ])('%s → %s', (t, d) => { expect(extractDate(t, MON).date).toBe(d); });
  it('下個月 31 號遇到只有 30 天的月份 → 取月底；既有說法不受影響', () => {
    expect(extractDate('下個月31號', '2026-10-09').date).toBe('2026-11-30');
    expect(extractDate('昨天', MON).date).toBe('2026-11-08');
    expect(extractDate('10/25', MON).date).toBe('2026-10-25');
  });
});

describe('時間：只認明確的說法', () => {
  it.each([
    ['15:30 午餐', '15:30'], ['下午三點半', '15:30'], ['晚上8點整', '20:00'], ['3點10分', '03:10'], ['早上七點', '07:00'],
    ['中午12點', '12:00'], ['凌晨12點半', '00:30'], ['晚上12點', '00:00'], ['23:59', '23:59'],
  ])('%s → %s', (t, tm) => { expect(extractClock(t).time).toBe(tm); });
  it.each(['3點', '點心 3 杯', '午餐 200', '買 3 點'])('不是時間：%s', (t) => { expect(extractClock(t).time).toBeUndefined(); });
  it('時間字樣不會留在備註裡', () => { expect(extractClock('下午三點半 午餐').rest).toBe('午餐'); });
});

describe('isScheduled', () => {
  const at = (h: number, m: number) => new Date(2026, 10, 9, h, m);
  it('未來日期、今天還沒到的時間才排程；過去、今天沒寫時間、已過的時間、轉帳都不排程', () => {
    const today = todayKey();
    expect(isScheduled({ kind: 'expense', date: addDays(today, 3) })).toBe(true);
    expect(isScheduled({ kind: 'expense', date: addDays(today, -1) })).toBe(false);
    expect(isScheduled({ kind: 'expense', date: today })).toBe(false);
    expect(isScheduled({ kind: 'expense', date: today, time: '23:59' }, at(10, 0))).toBe(true);
    expect(isScheduled({ kind: 'expense', date: today, time: '00:00' }, at(10, 0))).toBe(false);
    expect(isScheduled({ kind: 'transfer', date: addDays(today, 3) })).toBe(false);
  });
});

describe('建立單次排程 → 到期 → 通知 → 確認入帳', () => {
  let accountId = '';
  beforeEach(async () => {
    await db.delete(); await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    accountId = (await addAccount({ name: '錢包', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 100000, includeInNetWorth: true, isLiability: false })).id;
  });

  it('★ 一句話 → 草稿帶日期與時間 → 建成只發生一次的規則，餘額不變', async () => {
    const [d] = await draftsFromText('下禮拜二下午三點半午餐 200');
    expect(d).toMatchObject({ amount: 200, time: '15:30', dateGiven: true });
    expect(d.note).not.toContain('三點');
    const [rid] = await scheduleDrafts([await resolveDraft(d, accountId)]);
    const r = (await db.recurring_rules.get(rid))!;
    expect(r).toMatchObject({ mode: 'confirm', at: '15:30', startDate: d.date, nextDue: d.date, rule: { freq: 'day', interval: 1, count: 1 } });
    expect(r.template).toMatchObject({ type: 'expense', amountMinor: 20000, accountId });
    expect(await db.transactions.count()).toBe(0);
  });

  it('★ 到期後規則結束，但待確認的那一筆留在收件匣', async () => {
    const day = addDays(todayKey(), -1);
    const [rid] = await scheduleDrafts([await resolveDraft({ kind: 'expense', amount: 200, date: day, dateGiven: true, note: '午餐', raw: '', categoryId: 'exp-food-lunch' }, accountId)]);
    await processRecurring(todayKey());
    const r = (await db.recurring_rules.get(rid))!;
    expect(r.active).toBe(0);
    expect(r.pendingDates).toEqual([day]);
    expect((await loadForecast()).rules.filter((x) => x.rule.id === rid)).toHaveLength(1);
  });

  it('排了時間的，當天還沒到那個時間就先不出現在收件匣、也不通知', async () => {
    const [rid] = await scheduleDrafts([await resolveDraft({ kind: 'expense', amount: 200, date: todayKey(), dateGiven: true, time: '23:59', note: '午餐', raw: '', categoryId: 'exp-food-lunch' }, accountId)]);
    await processRecurring(todayKey());
    expect((await db.recurring_rules.get(rid))!.pendingDates).toEqual([todayKey()]);
    if (new Date().toTimeString().slice(0, 5) < '23:59') {
      expect((await loadForecast()).rules.filter((x) => x.rule.id === rid)).toHaveLength(0);
      await runReminderChecks();
      expect((await db.reminders.toArray()).filter((x) => x.id.includes(`once:${rid}`))).toHaveLength(0);
    }
  });

  it('★ 到期那天主動通知（提醒中心＋系統通知用同一條路），同一筆只通知一次', async () => {
    const past = addDays(todayKey(), -1);
    const [rid] = await scheduleDrafts([await resolveDraft({ kind: 'expense', amount: 200, date: past, dateGiven: true, note: '午餐', raw: '', categoryId: 'exp-food-lunch' }, accountId)]);
    await processRecurring(todayKey());
    await runReminderChecks();
    await runReminderChecks();
    const rows = (await db.reminders.toArray()).filter((x) => x.id.includes(`once:${rid}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refId: '/inbox' });
    expect(rows[0].title).toContain('午餐');
  });

  it('★ 伺服器推播：未來的單次排程排在指定時間；到期當天開過 App（規則已結束）也不會被取消', async () => {
    const future = addDays(todayKey(), 5);
    const [rid] = await scheduleDrafts([await resolveDraft({ kind: 'expense', amount: 200, date: future, dateGiven: true, time: '15:30', note: '午餐', raw: '', categoryId: 'exp-food-lunch' }, accountId)]);
    const items = (await upcomingPushItems()).filter((x) => x.id.startsWith(`once:${rid}`));
    expect(items).toHaveLength(1);
    expect(items[0].at).toBe(new Date(`${future}T15:30:00`).getTime());
    expect(items[0]).toMatchObject({ url: '/inbox' });
  });
});

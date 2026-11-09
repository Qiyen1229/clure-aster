/**
 * 預計扣款 → 收件匣待確認項目（App 端，全部在本機）。
 *
 * 兩種來源合在收件匣的同一區：
 *  ① 週期帳目（設定為「到期要確認」）已到期、還沒確認的期數（原本只在「規劃 → 週期」看得到）
 *  ② 還沒登記、但從記帳紀錄看起來是固定扣款（訂閱、房租、保費…）的項目，預計扣款日到了就出現
 * 每一項可以一鍵記帳（金額沿用上次，可改）、略過這一次，或登記成週期帳目。
 * 「略過」的 id 存在本機 meta（不同步）；最多保留 100 筆。
 */
import { db } from '@/db/schema';
import { addTransaction, type TxInput } from '@/db/repo/ledger';
import { confirmPending, processRecurring, skipPending } from '@/db/repo/plan';
import { detectInsights } from '@/domain/anomaly';
import { forecastCharges, type ForecastItem } from '@/domain/forecast';
import { todayKey } from '@/domain/period';
import type { RecurringRule } from '@/db/types';
import { useSettings } from '@/stores/settings';
import { useInboxCount } from './inboxCount';
import { createSubscriptionFrom, loadDetectInput } from './insights';

const SKIP_KEY = 'forecast.skipped';
const MAX_SKIPPED = 100;

export interface PendingRuleItem { id: string; rule: RecurringRule; date: string }
export interface ForecastData { rules: PendingRuleItem[]; predicted: ForecastItem[] }

export const forecastOn = () => useSettings.getState().inbox?.forecast !== false;

async function skippedSet(): Promise<Set<string>> {
  const v = (await db.meta.get(SKIP_KEY).catch(() => undefined))?.value;
  return new Set(Array.isArray(v) ? (v as string[]) : []);
}

/** 載入待確認的週期帳目與預計扣款，並更新首頁／導覽列的數字 */
export async function loadForecast(today = todayKey()): Promise<ForecastData> {
  // 單次排程到期後規則就結束（active=0），但還沒確認的那一筆要留著；排了時間的，當天要到那個時間才出現
  const nowHm = new Date().toTimeString().slice(0, 5);
  const rules: PendingRuleItem[] = (await db.recurring_rules.toArray())
    .filter((r) => (r.active || r.pendingDates.length) && r.pendingDates.length)
    .flatMap((r) => r.pendingDates.map((date) => ({ id: `rule:${r.id}:${date}`, rule: r, date })))
    .filter((it) => !(it.rule.rule.count === 1 && it.rule.at && it.date === today && nowHm < it.rule.at))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  let predicted: ForecastItem[] = [];
  if (forecastOn()) {
    const { input } = await loadDetectInput(today);
    const findings = detectInsights(input, new Set(useSettings.getState().insights?.dismissed ?? []));
    const accounts = new Set((await db.accounts.toArray()).filter((a) => !a.archived).map((a) => a.id));
    predicted = forecastCharges(findings, today, await skippedSet()).filter((p) => accounts.has(p.accountId));
  }
  // 週期帳目的待確認已經有鈴鐺通知，不重複計入數字；數字只算預計扣款
  useInboxCount.getState().setExtra(predicted.length);
  return { rules, predicted };
}

/** 啟動與回到前景時呼叫：只更新數字（失敗不影響其他事） */
export async function refreshForecastCount(): Promise<void> {
  try { await loadForecast(); } catch { /* 偵測用不到的資料不足時忽略 */ }
}

/** 記下這一次預計扣款（日期用預計扣款日），回傳新帳目 id 供「復原」 */
export async function bookForecast(p: ForecastItem, amountMinor = p.amountMinor): Promise<string> {
  const input: TxInput = {
    type: 'expense', accountId: p.accountId, categoryId: p.categoryId, amountMinor, currency: p.currency,
    date: p.dueDate, ts: new Date(`${p.dueDate}T09:00:00`).getTime(), note: p.name, tagIds: [],
  };
  const t = await addTransaction(input);
  await refreshForecastCount();
  return t.id;
}

export async function skipForecast(id: string): Promise<void> {
  const next = [...(await skippedSet()).values(), id].slice(-MAX_SKIPPED);
  await db.meta.put({ key: SKIP_KEY, value: [...new Set(next)] });
  await refreshForecastCount();
}

/** 登記成週期帳目（到期請我確認）；馬上補算一次，這一期會變成「週期帳目待確認」 */
export async function registerForecast(p: ForecastItem): Promise<void> {
  const f = p.finding;
  // 以預計扣款日（同一天）當作起點，而不是偵測用的 +30 天
  await createSubscriptionFrom({ ...f, subscription: { ...f.subscription!, nextDate: p.dueDate } });
  await processRecurring();
  await refreshForecastCount();
}

export const confirmRulePending = async (it: PendingRuleItem, amountMinor?: number) => { await confirmPending(it.rule.id, it.date, amountMinor); await refreshForecastCount(); };
export const skipRulePending = async (it: PendingRuleItem) => { await skipPending(it.rule.id, it.date); await refreshForecastCount(); };

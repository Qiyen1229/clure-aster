/**
 * 異常與訂閱偵測、預算預警的執行層（資料讀取、快取、通知、略過、建立訂閱）。
 *
 * - 偵測本身是 domain/anomaly、domain/budgetwarn 的純函式：全部在本機用規則運算，不使用 AI、不呼叫伺服器、不計入 AI 額度
 * - 效能：只讀最近 14 個月的帳目（日期索引）；結果快取在 meta（不同步），10 分鐘內且帳目筆數沒變就直接用快取；
 *   開啟 App 時排在閒置時間執行，不影響首屏
 * - 使用者主動操作（重新偵測、看白話說明）另有「5 分鐘最多 10 次」的限制（services/usageLimit）
 * - 通知：新的「建議看一下」項目與預算預警各自只通知一次（以項目 id 去重），一次最多 3 則
 */
import { db } from '@/db/schema';
import { computeBudgets, saveRecurring } from '@/db/repo/plan';
import { detectInsights, surgeWindows, type Finding } from '@/domain/anomaly';
import { forecastAll, type BudgetWarning } from '@/domain/budgetwarn';
import { formatMoney } from '@/domain/money';
import { accountingMonth, addDays, todayKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';
import { notify } from './notifications';

export interface InsightsSnapshot {
  at: number;
  txCount: number;
  findings: Finding[];
  warnings: BudgetWarning[];
}

const CACHE_KEY = 'insights.cache';
const FRESH_MS = 10 * 60_000;
const MAX_DISMISSED = 200;

export const insightsOn = () => {
  const i = useSettings.getState().insights;
  return !!i && (i.anomaly || i.budgetWarn);
};

export async function loadSnapshot(): Promise<InsightsSnapshot | null> {
  return ((await db.meta.get(CACHE_KEY).catch(() => undefined))?.value as InsightsSnapshot | undefined) ?? null;
}

/** 計算（不通知、不看快取）。回傳結果並寫入快取 */
export async function computeInsights(today = todayKey()): Promise<InsightsSnapshot> {
  const st = useSettings.getState();
  const cfg = st.insights;
  const base = st.baseCurrency;
  const fmt = (m: number) => formatMoney(m, base, { decimals: 0 });
  let findings: Finding[] = [];
  let warnings: BudgetWarning[] = [];

  if (cfg.anomaly) {
    const [cats, rules] = await Promise.all([db.categories.toArray(), db.recurring_rules.toArray()]);
    const byId = new Map(cats.map((c) => [c.id, c]));
    const mainOf = (id: string) => byId.get(id)?.parentId || id;
    const catName = (id: string) => byId.get(mainOf(id))?.name ?? '其他';
    const month = accountingMonth(today, st.monthStartDay);
    const prevStarts: string[] = [];
    let cursor = month.start;
    for (let i = 0; i < 3; i++) { cursor = accountingMonth(addDays(cursor, -1), st.monthStartDay).start; prevStarts.push(cursor); }
    // 偵測要看近 14 個月；暴增需要的前三個月已包含在內
    const from = addDays(today, -430);
    const txs = await db.transactions.where('date').between(from, today, true, true).toArray();
    // 「午餐」「早餐」這類分類名稱不是店家，不拿來判斷重複扣款
    const genericKeys = new Set(cats.map((c) => c.name.toLowerCase().replace(/[\d\s]+/g, '')).filter((k) => k.length >= 2));
    findings = detectInsights({
      txs, rules: rules.filter((r) => r.active).map((r) => ({ name: r.name, template: r.template })),
      today, fmt, catName, mainOf, windows: surgeWindows(month, today, prevStarts), genericKeys,
      isSubscriptionCat: (id) => /訂閱|subscription/i.test(byId.get(mainOf(id))?.name ?? '') || /訂閱|subscription/i.test(byId.get(id)?.name ?? ''),
    }, new Set(cfg.dismissed));
  }

  if (cfg.budgetWarn) {
    const views = await computeBudgets(today);
    warnings = forecastAll(views.map((v) => ({
      id: v.budget.id, name: v.budget.name, limit: v.status.limit, spent: v.status.spent, period: v.period, today,
      projected: v.projection.projected,
    })), (m) => formatMoney(m, base, { decimals: 0 }));
  }

  const snap: InsightsSnapshot = { at: Date.now(), txCount: await db.transactions.count(), findings, warnings };
  await db.meta.put({ key: CACHE_KEY, value: snap });
  return snap;
}

/** 開啟 App／回到前景時呼叫：快取還新就直接用；有新的重要項目就通知（不計入使用次數限制） */
export async function runInsights(opts: { notifyNew?: boolean; force?: boolean } = {}): Promise<InsightsSnapshot | null> {
  if (!insightsOn()) return null;
  const cached = await loadSnapshot();
  const count = await db.transactions.count();
  if (!opts.force && cached && Date.now() - cached.at < FRESH_MS && cached.txCount === count) return cached;
  const snap = await computeInsights();
  if (opts.notifyNew) await notifyNew(snap);
  return snap;
}

async function notifyNew(snap: InsightsSnapshot) {
  let sent = 0;
  for (const w of snap.warnings) {
    if (sent >= 3) return;
    // 已超支、或已用 80% 以上：既有的「預算警示」提醒已經會通知，這裡只負責「還沒到門檻但照目前花法會超支」的提早提醒
    if (w.level === 'over' || (w.limit > 0 && (w.spent / w.limit) * 100 >= 80)) continue;
    if (await db.reminders.get(w.id)) continue;
    await notify(`🔔 ${w.title}`, w.tip, '/plan?tab=budget', 'budget', w.id);
    sent++;
  }
  for (const f of snap.findings.filter((x) => x.severity === 'warn')) {
    if (sent >= 3) return;
    if (await db.reminders.get(f.id)) continue;
    await notify(`🔎 ${f.title}`, f.tip, '/insights', 'insight', f.id);
    sent++;
  }
}

/** 略過這一項：之後不再提醒（隨帳號同步；只保留最近 200 筆） */
export async function dismissFinding(id: string) {
  const s = useSettings.getState();
  const next = [...s.insights.dismissed.filter((x) => x !== id), id].slice(-MAX_DISMISSED);
  s.set('insights', { ...s.insights, dismissed: next });
  const snap = await loadSnapshot();
  if (snap) await db.meta.put({ key: CACHE_KEY, value: { ...snap, findings: snap.findings.filter((f) => f.id !== id) } });
}

/** 把「看起來是訂閱／固定扣款」的項目登記成訂閱或週期帳目（處理方式：到期提醒我確認，不會自作主張入帳） */
export async function createSubscriptionFrom(f: Finding): Promise<string> {
  if (!f.subscription) throw new Error('這一項不是訂閱');
  const s = f.subscription;
  const id = await saveRecurring({
    kind: s.kind, name: s.name, startDate: s.nextDate, mode: 'confirm', remindDaysBefore: 3, active: 1,
    rule: { freq: s.period, interval: 1 },
    template: { type: 'expense', accountId: s.accountId, categoryId: s.categoryId, amountMinor: s.amountMinor, currency: s.currency, note: s.name },
    ...(s.kind === 'subscription' ? { subscription: { service: s.name, priceHistory: [{ date: f.date, amountMinor: s.amountMinor }] } } : {}),
  });
  await dismissFinding(f.id);
  return id;
}

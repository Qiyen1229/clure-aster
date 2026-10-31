/**
 * 異常與訂閱偵測、預算預警的執行層（資料讀取、快取、通知、略過、建立訂閱）。
 *
 * - 偵測本身是 domain/anomaly、domain/budgetwarn、domain/pricing 的純函式：全部在本機用規則運算，不呼叫伺服器、不計入 AI 額度；
 *   只有規則判斷不了的「新支出」才（在使用者開啟 AI 功能時）請 AI 查市價，見 checkNewTransactions
 * - 效能：只讀最近 14 個月的帳目（日期索引）；結果快取在 meta（不同步），10 分鐘內且帳目筆數沒變就直接用快取；
 *   開啟 App 時排在閒置時間執行，不影響首屏
 * - 通知：新的「建議看一下」項目與預算預警各自只通知一次（以項目 id 去重），一次最多 3 則
 */
import { db } from '@/db/schema';
import { computeBudgets, saveRecurring } from '@/db/repo/plan';
import { detectInsights, expenseContext, highFinding, judgeOne, surgeWindows, type DetectInput, type Finding } from '@/domain/anomaly';
import { countsInStats, statAmount } from '@/domain/ledger';
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

/** 偵測需要的資料（分類、已登記的週期帳目、近 14 個月的帳目與各種查詢函式）：批次偵測與單筆檢查共用 */
export async function loadDetectInput(today = todayKey()) {
  const st = useSettings.getState();
  const base = st.baseCurrency;
  const fmt = (m: number) => formatMoney(m, base, { decimals: 0 });
  const [cats, rules] = await Promise.all([db.categories.toArray(), db.recurring_rules.toArray()]);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const mainOf = (id: string) => byId.get(id)?.parentId || id;
  const catName = (id: string) => byId.get(mainOf(id))?.name ?? '其他';
  const catPath = (id: string) => ({ name: byId.get(id)?.name ?? '其他', mainName: catName(id) });
  const month = accountingMonth(today, st.monthStartDay);
  const prevStarts: string[] = [];
  let cursor = month.start;
  for (let i = 0; i < 3; i++) { cursor = accountingMonth(addDays(cursor, -1), st.monthStartDay).start; prevStarts.push(cursor); }
  // 偵測要看近 14 個月；暴增需要的前三個月已包含在內
  const txs = await db.transactions.where('date').between(addDays(today, -430), today, true, true).toArray();
  // 「午餐」「早餐」這類分類名稱不是店家，不拿來判斷重複扣款
  const genericKeys = new Set(cats.map((c) => c.name.toLowerCase().replace(/[\d\s]+/g, '')).filter((k) => k.length >= 2));
  const input: DetectInput = {
    txs, rules: rules.filter((r) => r.active).map((r) => ({ name: r.name, template: r.template })),
    today, fmt, catName, catPath, mainOf, baseCurrency: base, windows: surgeWindows(month, today, prevStarts), genericKeys,
    isSubscriptionCat: (id) => /訂閱|subscription/i.test(byId.get(mainOf(id))?.name ?? '') || /訂閱|subscription/i.test(byId.get(id)?.name ?? ''),
  };
  return { input, cats: byId };
}

/** 系統在新支出出現時（含 AI 查市價）找到的「超出行情」提醒，另外保存；批次偵測時併入結果 */
interface AiStore { checked: string[]; findings: Finding[] }
const AI_KEY = 'insights.ai';
const MAX_CHECKED = 800;
const MAX_STORED = 30;
const loadAi = async (): Promise<AiStore> => ((await db.meta.get(AI_KEY).catch(() => undefined))?.value as AiStore | undefined) ?? { checked: [], findings: [] };
const saveAi = (v: AiStore) => db.meta.put({ key: AI_KEY, value: { checked: v.checked.slice(-MAX_CHECKED), findings: v.findings.slice(-MAX_STORED) } });

/** 計算（不通知、不看快取）。回傳結果並寫入快取 */
export async function computeInsights(today = todayKey()): Promise<InsightsSnapshot> {
  const cfg = useSettings.getState().insights;
  const fmt = (m: number) => formatMoney(m, useSettings.getState().baseCurrency, { decimals: 0 });
  let findings: Finding[] = [];
  let warnings: BudgetWarning[] = [];

  if (cfg.anomaly) {
    const { input } = await loadDetectInput(today);
    const dismissed = new Set(cfg.dismissed);
    findings = detectInsights(input, dismissed);
    // 併入新支出檢查找到的提醒（含 AI 查市價的結果）：帳目還在、近 30 天內、沒被略過、沒有重複
    const stored = (await loadAi()).findings.filter((f) => !dismissed.has(f.id) && f.date >= addDays(today, -30) && !findings.some((x) => x.id === f.id));
    if (stored.length) {
      const alive = await db.transactions.bulkGet(stored.flatMap((f) => f.txIds));
      const ok = new Set(alive.filter((t) => t && !t.deletedAt).map((t) => t!.id));
      findings = [...stored.filter((f) => f.txIds.every((id) => ok.has(id))), ...findings].sort((a, b) => (a.severity === 'warn' ? 0 : 1) - (b.severity === 'warn' ? 0 : 1) || b.amountMinor - a.amountMinor);
    }
  }

  if (cfg.budgetWarn) {
    const views = await computeBudgets(today);
    warnings = forecastAll(views.map((v) => ({
      id: v.budget.id, name: v.budget.name, limit: v.status.limit, spent: v.status.spent, period: v.period, today,
      projected: v.projection.projected,
    })), fmt);
  }

  const snap: InsightsSnapshot = { at: Date.now(), txCount: await db.transactions.count(), findings, warnings };
  await db.meta.put({ key: CACHE_KEY, value: snap });
  return snap;
}

/**
 * 新增支出時，系統自動檢查「這一筆」合不合理（每一筆只檢查一次，使用者無法手動重跑）：
 *  1. 本機規則：先看你的習慣、再看這個分類的市價；大額項目（家電、學費、買車…）不提醒
 *  2. 規則判斷不了、而且比平常高很多時：若你開啟了 AI 功能，請 AI 查市價（不計額度）；沒開 AI 就只在「離譜到極端」時才提醒
 * 有問題的存起來並通知；回傳這次新增的提醒數。
 */
export async function checkNewTransactions(ids: string[], today = todayKey()): Promise<number> {
  const st = useSettings.getState();
  if (!st.insights.anomaly || !ids.length) return 0;
  const store = await loadAi();
  const todo = ids.filter((id) => !store.checked.includes(id));
  if (!todo.length) return 0;
  store.checked.push(...todo);
  await saveAi(store); // 先記下「檢查過了」：中途失敗也不會重複檢查或重複問 AI

  const { input, cats } = await loadDetectInput(today);
  const pool = input.txs.filter((t) => t.type === 'expense' && !t.deletedAt && !t.transferId && !t.stockTradeId && !t.installmentId && statAmount(t) > 0 && countsInStats(t));
  const ctx = expenseContext(pool, today, input.mainOf);
  const { aiPriceCheck } = await import('./ai');
  let added = 0;
  let aiCalls = 0;
  for (const id of todo) {
    const t = await db.transactions.get(id);
    if (!t || t.deletedAt || t.type !== 'expense') continue;
    const j = judgeOne(input, ctx, t);
    if (!j || j.verdict === 'ok') continue;
    let f: Finding | null = null;
    if (j.verdict === 'high') f = highFinding(input, t, j);
    else {
      // unknown：請 AI 查市價（一次最多 5 筆，避免批次匯入時狂問）
      const path = input.catPath?.(t.categoryId) ?? { name: input.catName(t.categoryId), mainName: input.catName(t.categoryId) };
      const v = aiCalls < 5
        ? await aiPriceCheck({ category: cats.get(t.categoryId)?.parentId ? `${path.mainName} > ${path.name}` : path.name, note: [t.merchant, t.note].filter(Boolean).join(' '), amount: statAmount(t) / 100, currency: st.baseCurrency, date: t.date, usual: j.habit ? j.habit.median / 100 : undefined })
        : null;
      if (v) aiCalls++;
      if (v?.verdict === 'high') {
        const range = v.typical_min && v.typical_max ? `AI 查到一般行情約 ${input.fmt(v.typical_min * 100)}～${input.fmt(v.typical_max * 100)}` : 'AI 評估這個金額高於一般行情';
        f = highFinding(input, t, j, `${range}${v.reason ? `（${v.reason}）` : ''}。`);
      } else if (!v && j.extreme) f = highFinding(input, t, j); // 沒有 AI 可問：只在離譜到極端時提醒
    }
    if (!f) continue;
    const cur = await loadAi();
    await saveAi({ ...cur, findings: [...cur.findings.filter((x) => x.id !== f!.id), f] });
    if (!(await db.reminders.get(f.id))) await notify(`🔎 ${f.title}`, f.tip, '/insights', 'insight', f.id);
    added++;
  }
  if (added) await runInsights({ force: true });
  return added;
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

// ───────────── 每新增一筆支出就檢查一次 ─────────────

const watched = new WeakSet<object>();
const BATCH_LIMIT = 20; // 一次新增超過這個數量（匯入、批次）不逐筆檢查

/** 新支出的資格：剛剛才建立（同步下載的舊帳目、備份還原的不算）、一般支出（不含轉帳、分期、週期入帳） */
export function isFreshExpense(t: { type?: string; deletedAt?: number | null; transferId?: string; installmentId?: string; recurringRuleId?: string; stockTradeId?: string; createdAt?: number }, now = Date.now()): boolean {
  return t.type === 'expense' && !t.deletedAt && !t.transferId && !t.installmentId && !t.recurringRuleId && !t.stockTradeId && now - (t.createdAt ?? 0) < 120_000;
}

/**
 * 監看這台裝置上新增的支出（Dexie creating hook）：1.5 秒內的新增合併成一批，逐筆檢查一次。
 * 只排隊、不在交易內做任何事；同步下載、匯入、還原的帳目不會觸發。每個資料庫實例只安裝一次。
 */
export function installNewTxWatcher(): void {
  if (watched.has(db)) return;
  watched.add(db);
  const queue = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    const ids = [...queue];
    queue.clear();
    timer = undefined;
    if (ids.length > BATCH_LIMIT) return;
    void checkNewTransactions(ids).catch(() => undefined);
  };
  db.transactions.hook('creating', (_pk, obj) => {
    if (!isFreshExpense(obj) || !useSettings.getState().insights?.anomaly) return;
    queue.add(obj.id);
    clearTimeout(timer);
    timer = setTimeout(flush, 1500);
  });
  // 帳目被刪除、改金額、還原或新增時，預算預警與異常結果都會跟著變：稍後重算一次（合併連續變動）。
  // 否則刪掉那筆大額支出後，首頁「需要你看一下」仍停在舊的快取，要等 10 分鐘或重開 App 才會消失
  let refresh: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (!insightsOn()) return;
    clearTimeout(refresh);
    refresh = setTimeout(() => { void runInsights({ force: true }).catch(() => undefined); }, 1200);
  };
  db.transactions.hook('creating', () => { scheduleRefresh(); });
  db.transactions.hook('updating', () => { scheduleRefresh(); });
  db.transactions.hook('deleting', () => { scheduleRefresh(); });
}

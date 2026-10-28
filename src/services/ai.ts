/**
 * AI 輔助解析（選用）：一句話記帳規則看不懂時的後備。
 * - 預設關閉，使用者在「設定 → AI 輔助」手動開啟；只有明確送出（按下記帳／說完）才會呼叫，輸入中的即時預覽不會用到額度。
 * - 只送使用者輸入的那一句話與分類／帳戶「名稱」，不送帳目紀錄與餘額；伺服器端有每日／每週／每月額度。
 * - 端對端加密不涵蓋這個功能：內容會經過你的伺服器與 AI 供應商。
 *
 * v2.0 擴充：問答、下月預算建議、週報月報洞察、整理分類、拍照記帳。
 * - 需要「收支統計」的功能（問答、預算、洞察）另外要使用者開啟 ai.allowData；送出的是 domain/aisummary 整理的去識別化統計。
 * - 結果快取在這台裝置（meta 表，不同步）：同樣的資料同樣的問題不會重複呼叫，省免費額度。
 */
import { aiEntriesToDrafts, namesForAi, sanitizeForAi, type AiEntry } from '@/domain/aiparse';
import { hashJson, periodToAi } from '@/domain/aisummary';
import type { AiSearchPlan } from '@/domain/search';
import type { DraftEntry } from '@/domain/nlp';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { db } from '@/db/schema';
import { api } from './api';
import { parseContext } from './quickentry';

export interface AiQuotaWindow { limit: number; used: number; remaining: number | null; resets_at: string }
export interface AiQuota { daily: AiQuotaWindow; weekly: AiQuotaWindow; monthly: AiQuotaWindow }
export interface AiStatus { role: 'user' | 'admin'; enabled: boolean; configured: boolean; available: boolean; message: string; quota: AiQuota }

export const aiEnabledLocally = () => AUTH_ENABLED && !!useSettings.getState().ai?.enabled && navigator.onLine;

export const getAiStatus = () => api<AiStatus>('/ai/status');

/**
 * 呼叫伺服器解析一句話；失敗（額度用完、供應商掛了、看不懂）會丟出帶中文訊息的錯誤。
 * 同一句話進行中、或 5 秒內剛解析過，直接共用結果，不會重複送出（連點、重複觸發都不會多扣額度）。
 */
const recent = new Map<string, Promise<{ drafts: DraftEntry[]; quota: AiQuota }>>();
export function aiParse(text: string) {
  const key = text.trim();
  const hit = recent.get(key);
  if (hit) return hit;
  const p = aiParseOnce(key);
  recent.set(key, p);
  const drop = () => setTimeout(() => recent.delete(key), 5000);
  p.then(drop, () => recent.delete(key)); // 失敗不保留，讓使用者可以立刻重試
  return p;
}

async function aiParseOnce(text: string): Promise<{ drafts: DraftEntry[]; quota: AiQuota }> {
  const ctx = await parseContext();
  const names = namesForAi({ today: ctx.today, accounts: ctx.accounts, categories: ctx.categories });
  const res = await api<{ entries: AiEntry[]; quota: AiQuota }>('/ai/parse-entry', { method: 'POST', body: { text, ...names, today: ctx.today } });
  return { drafts: aiEntriesToDrafts(res.entries, ctx, text), quota: res.quota };
}

/** "剩 N 次" 的簡短說明（取最緊的那一層） */
export function quotaLabel(q: AiQuota): string {
  const rem = [q.daily, q.weekly, q.monthly].filter((w) => w.remaining !== null).map((w) => w.remaining as number);
  return rem.length ? `AI 額度剩 ${Math.min(...rem)} 次` : 'AI 額度不限';
}


// ───────────── v2：需要收支統計的功能 ─────────────

/** AI 已啟用，而且使用者也允許 AI 看去識別化的收支統計 */
export const aiDataEnabled = () => aiEnabledLocally() && !!useSettings.getState().ai?.allowData;

export interface Cached<T> { value: T; cached: boolean; quota?: AiQuota }

/**
 * 結果快取在本機 meta 表（不同步）。同一個鍵在 ttl 內直接回傳，不呼叫伺服器、不扣額度；
 * 同一個鍵正在呼叫時，後來的請求共用同一次結果（連點、重複觸發都不會多扣）。
 */
const pending = new Map<string, Promise<Cached<unknown>>>();

const cacheId = (kind: string, key: unknown) => `ai-cache:${kind}:${hashJson(key)}`;

function cached<T extends { quota?: AiQuota }>(kind: string, key: unknown, ttlMs: number, run: () => Promise<T>, force = false): Promise<Cached<Omit<T, 'quota'>>> {
  const id = cacheId(kind, key);
  const running = pending.get(id);
  if (running) return running as Promise<Cached<Omit<T, 'quota'>>>;
  const p = (async (): Promise<Cached<Omit<T, 'quota'>>> => {
    if (!force) {
      const hit = (await db.meta.get(id).catch(() => undefined))?.value as { at: number; value: Omit<T, 'quota'> } | undefined;
      if (hit && Date.now() - hit.at < ttlMs) return { value: hit.value, cached: true };
    }
    const { quota, ...value } = await run();
    await db.meta.put({ key: id, value: { at: Date.now(), value } }).catch(() => undefined);
    void trimCache();
    return { value: value as Omit<T, 'quota'>, cached: false, quota };
  })();
  pending.set(id, p);
  const done = () => { pending.delete(id); };
  p.then(done, done);
  return p;
}

/** 只留最近 40 筆快取，避免 meta 表越長越大 */
async function trimCache() {
  const rows = (await db.meta.toArray()).filter((r) => r.key.startsWith('ai-cache:')) as { key: string; value: { at: number } }[];
  if (rows.length <= 40) return;
  rows.sort((a, b) => a.value.at - b.value.at);
  await db.meta.bulkDelete(rows.slice(0, rows.length - 40).map((r) => r.key));
}

const HOUR = 3600_000;

export interface AskValue { answer: string; followups: string[] }

export async function aiAsk(question: string): Promise<Cached<AskValue>> {
  const { loadFinanceSummary } = await import('./aisummary');
  const { summary } = await loadFinanceSummary();
  const q = question.trim();
  return cached('ask', { q, summary }, 6 * HOUR, () => api<AskValue & { quota: AiQuota }>('/ai/ask', { method: 'POST', body: { question: q, summary } }));
}

export interface PlanValue { total: number; categories: { name: string; amount: number; reason: string }[]; tips: string[]; assumption: string }
export interface PlanResult extends PlanValue { daily: number; fixedTotal: number; days: number; label: string; currency: string; decimals: number }

export async function aiBudgetPlan(force = false): Promise<Cached<PlanResult>> {
  const { loadFinanceSummary } = await import('./aisummary');
  const { dailyAllowance } = await import('@/domain/aisummary');
  const { summary, decimals, categories } = await loadFinanceSummary();
  const r = await cached('budget', { summary, categories }, 12 * HOUR, () => api<PlanValue & { quota: AiQuota }>('/ai/budget-plan', { method: 'POST', body: { summary, categories } }), force);
  const fixedTotal = summary.fixedMonthly.total;
  const value: PlanResult = { ...r.value, fixedTotal, days: summary.nextMonth.days, label: summary.nextMonth.label, currency: summary.currency, decimals,
    daily: dailyAllowance(r.value.total, fixedTotal, summary.nextMonth.days) };
  return { ...r, value };
}

export interface InsightsValue { headline: string; points: string[]; suggestion: string }

/** 週報／月報的白話洞察：data 是 domain/aisummary.periodToAi 的輸出 */
export async function aiInsights(label: string, data: ReturnType<typeof periodToAi>, force = false): Promise<Cached<InsightsValue>> {
  return cached('insights', { label, data }, 24 * HOUR, () => api<InsightsValue & { quota: AiQuota }>('/ai/insights', { method: 'POST', body: { summary: data, label } }), force);
}

/** 替一批備註建議分類（備註文字會送出，所以這個功能算在「AI 輔助」開關下，不需要收支統計） */
export async function aiCategorize(notes: string[], categories: string[], kind: 'expense' | 'income' = 'expense'): Promise<{ items: { index: number; category: string }[]; quota: AiQuota }> {
  return api('/ai/categorize', { method: 'POST', body: { notes, categories, kind } });
}

/** 拍照記帳：照片縮小後送出，回傳草稿（和一句話記帳同樣的 DraftEntry，之後可補分類、帳戶） */
export async function aiReceipt(file: File): Promise<{ drafts: DraftEntry[]; quota: AiQuota }> {
  const { compressForAi } = await import('./attachments');
  const image = await compressForAi(file);
  const ctx = await parseContext();
  const names = namesForAi({ today: ctx.today, accounts: ctx.accounts, categories: ctx.categories });
  const res = await api<{ entries: AiEntry[]; quota: AiQuota }>('/ai/receipt', { method: 'POST', body: { image, ...names, today: ctx.today } });
  return { drafts: aiEntriesToDrafts(res.entries, ctx, '拍照記帳'), quota: res.quota };
}


// ───────────── v2.1：搜尋規劃、通用解說、自動週報 ─────────────

/** 搜尋：把一句話描述轉成搜尋條件（只送描述與分類／帳戶／標籤名稱，不送任何帳目） */
export async function aiSearchPlan(text: string): Promise<Cached<{ plan: AiSearchPlan }>> {
  const [cats, accs, tags, ctx] = await Promise.all([db.categories.toArray(), db.accounts.toArray(), db.tags.toArray(), parseContext()]);
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  const body = {
    text: text.trim().slice(0, 200), today: ctx.today,
    categories: uniq(cats.filter((c) => !c.archived && !c.system).map((c) => c.name)).slice(0, 120),
    accounts: uniq(accs.filter((a) => !a.archived).map((a) => a.name)).slice(0, 40),
    tags: uniq(tags.map((t) => t.name)).slice(0, 60),
  };
  const r = await cached('search', body, 6 * HOUR, async () => {
    const { quota, ...plan } = await api<AiSearchPlan & { quota: AiQuota }>('/ai/search-plan', { method: 'POST', body });
    return { plan, quota };
  });
  return r as Cached<{ plan: AiSearchPlan }>;
}

/** 專案、帳戶…的白話解說：data 是 domain/aisummary 整理的去識別化統計 */
export async function aiExplain(subject: string, data: object, force = false): Promise<Cached<InsightsValue>> {
  return cached('explain', { subject, data }, 12 * HOUR, () => api<InsightsValue & { quota: AiQuota }>('/ai/explain', { method: 'POST', body: { subject, summary: data } }), force);
}

/** 收件匣：規則看不懂的簡訊／通知，請 AI 解析（和一句話記帳同一個後端任務，扣 1 點） */
export async function aiParseText(text: string) {
  return aiParse(sanitizeForAi(text));
}

const TRY_MS = 6 * HOUR;

/**
 * 首頁「上週重點」：使用者開啟「自動產生」時，每週最多自動呼叫一次。
 * 已有結果直接回傳；沒有結果時 6 小時內最多嘗試一次（失敗、額度用完也不會一直重試）。
 */
export async function autoWeeklyInsight(): Promise<{ label: string; value: InsightsValue } | null> {
  if (!aiDataEnabled() || !useSettings.getState().ai?.auto) return null;
  const { loadSummary, lastCompleted, summaryRange, summaryTitle } = await import('./summary');
  const { currencyInfo } = await import('@/domain/money');
  const anchor = lastCompleted('week');
  const sum = await loadSummary('week', anchor);
  if (!sum.count) return null;
  const base = useSettings.getState().baseCurrency;
  const cats = new Map((await db.categories.toArray()).map((c) => [c.id, c]));
  const label = `上週 ${summaryTitle('week', summaryRange('week', anchor).range)}`;
  const data = periodToAi(sum, cats, label, base, currencyInfo(base).exp);
  const key = { label, data };
  const id = cacheId('autoweek', key);
  const hit = (await db.meta.get(id).catch(() => undefined))?.value as { at: number; value: InsightsValue } | undefined;
  if (hit && Date.now() - hit.at < 7 * 24 * HOUR) return { label, value: hit.value };
  const triedId = `ai-auto-try:${anchor}`;
  const tried = (await db.meta.get(triedId).catch(() => undefined))?.value as number | undefined;
  if (tried && Date.now() - tried < TRY_MS) return null;
  await db.meta.put({ key: triedId, value: Date.now() }).catch(() => undefined);
  try {
    const r = await cached('autoweek', key, 7 * 24 * HOUR, () => api<InsightsValue & { quota: AiQuota }>('/ai/insights', { method: 'POST', body: { summary: data, label } }));
    return { label, value: r.value };
  } catch { return null; }
}

/**
 * 開啟 App 時的補算任務（不阻塞首屏；網路類與本機類並行，較重的偵測排在瀏覽器閒置時一個接一個做）：
 *  ① 週期帳目到期展開 ② 分期期數入帳 ③ 匯率（>12h）④ 股價更新 ⑤ 到價提醒
 *  ⑥ 每日快照補齊 ⑦ 本地提醒（帳單、預算、訂閱、備份、週報／月報）⑧ 電子發票載具 ⑨ 收件匣
 * 盤中且畫面可見時，每 N 秒自動刷新股價（useQuoteAutoRefresh）。
 */
import { useEffect } from 'react';
import { db } from '@/db/schema';
import { processInstallments, processRecurring } from '@/db/repo/plan';
import { checkPriceAlerts } from '@/db/repo/invest';
import { refreshRatesIfStale } from './fx';
import { describeQuoteErrors, refreshQuotes } from './quotes/registry';
import { takeSnapshot } from './snapshots';
import { addTwHolidays, marketState, parseTwseHolidays } from '@/domain/invest/market-hours';
import { getJson } from './quotes/http';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { notify, runReminderChecks } from './notifications';

/** 需要更新報價的標的：有持股或在觀察清單中 */
export async function trackedStocks() {
  const [trades, watch] = await Promise.all([db.stock_trades.toArray(), db.watchlist.toArray()]);
  const ids = new Set([...trades.filter((t) => !t.deletedAt).map((t) => t.stockId), ...watch.map((w) => w.stockId)]);
  return (await db.stocks.bulkGet([...ids])).filter((s): s is NonNullable<typeof s> => !!s);
}

export async function updateAllQuotes(opts: { silent?: boolean } = {}) {
  const stocks = await trackedStocks();
  if (!stocks.length) return null;
  const r = await refreshQuotes(stocks);
  const hits = await checkPriceAlerts();
  for (const h of hits) await notify(h.title, h.body, h.url, 'price_alert', h.id);
  await takeSnapshot().catch(() => undefined);
  if (!opts.silent && r.failed.length) {
    useUI.getState().showSnack({ text: `${r.failed.length} 檔報價更新失敗，顯示最後一次價格（${describeQuoteErrors(r.errors)}）`, duration: 7000 });
  }
  return r;
}

const HOLIDAY_URL = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';

/** 台股休市日：快取在 meta（7 天），過期才向證交所更新；失敗時沿用快取與內建清單 */
export async function loadTwHolidays(): Promise<void> {
  const cached = (await db.meta.get('twHolidays'))?.value as { at: number; dates: string[] } | undefined;
  if (cached?.dates) addTwHolidays(cached.dates);
  if (cached && Date.now() - cached.at < 7 * 86400_000) return;
  const rows = await getJson<{ Name?: string; Date?: string; Description?: string }[]>(HOLIDAY_URL, { retries: 1 });
  const dates = parseTwseHolidays(rows);
  if (!dates.length) return;
  addTwHolidays(dates);
  await db.meta.put({ key: 'twHolidays', value: { at: Date.now(), dates: [...new Set([...(cached?.dates ?? []), ...dates])] } });
}

/** 瀏覽器閒置時才執行（不支援就稍後執行） */
const idle = (fn: () => void) => ('requestIdleCallback' in window ? (window as unknown as { requestIdleCallback: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback(fn, { timeout: 8000 }) : setTimeout(fn, 2500));

let started = false;
export async function runStartupTasks() {
  if (started) return;
  started = true;
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { console.warn(`[startup] ${name}`, e); }
  };
  const base = useSettings.getState().baseCurrency;
  let created = 0, pending = 0;
  await step('recurring', async () => { const r = await processRecurring(); created += r.created; pending += r.pending; });
  await step('installments', async () => { created += await processInstallments(); });
  if (created || pending) {
    useUI.getState().showSnack({ text: [created ? `已自動入帳 ${created} 筆週期／分期帳目` : '', pending ? `${pending} 筆待確認` : ''].filter(Boolean).join('，') });
  }
  // 監看帳目變動的 hook 先裝好（很輕、不等網路）：啟動期間新記的帳不會漏掉
  void step('newTxWatcher', () => import('./insights').then((m) => m.installNewTxWatcher()));
  void step('pushRefresh', () => import('./push').then((m) => m.installPushRefresh()));
  // 兩條互不相干的路並行：①網路（匯率、休市日 → 股價 → 每日快照；快照要用新的價格與匯率）②本機提醒檢查
  const network = (async () => {
    await Promise.all([step('fx', () => refreshRatesIfStale(base)), step('holidays', () => loadTwHolidays())]);
    await step('quotes', () => updateAllQuotes({ silent: true }));
    await step('snapshot', () => takeSnapshot());
  })();
  const local = step('reminders', () => runReminderChecks());
  // 比較重的偵測全部排到瀏覽器閒置時，而且一個接一個做（不同時搶主執行緒）：發票對獎 → 除息前提醒 → 異常與預算預警（有 10 分鐘快取）
  idle(() => void (async () => {
    await step('invoicePrize', () => import('./invoicePrize').then((m) => m.checkPrizesOnStartup()));
    await step('taxplan', () => import('./taxplan').then((m) => m.notifyUpcomingDividends()));
    await step('insights', () => import('./insights').then((m) => m.runInsights({ notifyNew: true })));
  })());
  await Promise.all([network, local]);
  // 對外通道與背景推播排程、電子發票載具、收件匣：都是網路請求，彼此獨立，並行進行
  await Promise.all([
    (async () => {
      await step('outgoing', () => import('./outgoing').then((m) => m.refreshOutgoingActive()));
      if (useSettings.getState().notify.push || (await import('./outgoing').then((m) => m.hasActiveChannels()))) await step('push', () => import('./push').then((m) => m.schedulePush()));
    })(),
    step('carrier', async () => {
      const r = await (await import('./carrier')).syncCarrier();
      if (r && (r.created || r.matched)) {
        useUI.getState().showSnack({ text: `電子發票：新記 ${r.created} 筆${r.matched ? `、對到 ${r.matched} 筆手動記帳` : ''}${r.usedDefault ? `（${r.usedDefault} 筆記到預設帳戶）` : ''}` });
      }
    }),
    // 預計扣款：只更新收件匣的數字（本機推算）
    step('forecast', () => import('./forecast').then((m) => m.refreshForecastCount())),
    // 自動記帳收件匣（iPhone 捷徑送來的 Apple Pay、簡訊、Siri）
    step('inbox', () => import('./inbox').then((m) => m.refreshInbox())),
  ]);
}

/**
 * 背景循環（App 在前景時）：盤中每 N 秒刷新報價；回到前景時處理收件匣（30 秒節流）與補跑週期帳目、提醒檢查（10 分鐘節流）。
 * 回傳清除函式。
 */
export function startAutoRefresh(): () => void {
  let lastQuote = Date.now();
  let lastChecks = Date.now();
  let lastInbox = Date.now();
  const tick = async () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    const sec = useSettings.getState().quote.refreshSec;
    if (sec >= 15 && Date.now() - lastQuote >= sec * 1000) {
      lastQuote = Date.now();
      const stocks = await trackedStocks();
      if (stocks.some((s) => marketState(s.market) === 'open')) await updateAllQuotes({ silent: true }).catch(() => undefined);
    }
  };
  const onVis = async () => {
    if (document.visibilityState !== 'visible') return;
    // 收件匣每次回到前景都處理（30 秒節流），不等 10 分鐘的補算：刷卡通知送進來要盡快看到
    if (Date.now() - lastInbox >= 30_000) {
      lastInbox = Date.now();
      void import('./inbox').then((m) => m.refreshInbox()).catch(() => undefined);
    }
    if (Date.now() - lastChecks < 10 * 60 * 1000) return;
    lastChecks = Date.now();
    await processRecurring().catch(() => undefined);
    await processInstallments().catch(() => undefined);
    await takeSnapshot().catch(() => undefined);
    await runReminderChecks().catch(() => undefined);
    void import('./push').then((m) => m.schedulePush()).catch(() => undefined); // 滾動更新接下來 14 天的排程
    await import('./insights').then((m) => m.runInsights({ notifyNew: true })).catch(() => undefined);
    await import('./forecast').then((m) => m.refreshForecastCount()).catch(() => undefined);
  };
  const id = setInterval(() => void tick(), 5000);
  document.addEventListener('visibilitychange', onVis);
  return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
}

/** 盤中自動刷新（hook 版本） */
export function useQuoteAutoRefresh() {
  const sec = useSettings((s) => s.quote.refreshSec);
  useEffect(() => {
    if (!sec || sec < 15) return;
    const tick = async () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      const stocks = await trackedStocks();
      if (stocks.some((s) => marketState(s.market) === 'open')) await updateAllQuotes({ silent: true });
    };
    const id = setInterval(() => void tick(), sec * 1000);
    const onVis = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [sec]);
}

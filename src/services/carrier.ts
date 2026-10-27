/**
 * 手機條碼載具自動記帳：經自架伺服器（持有財政部 AppID）查詢載具發票，再依規則／商家記憶／預設帳戶記帳。
 *
 * - 開啟 App 時執行（6 小時內不重複）；先完成一次跨裝置同步，避免兩台裝置重複記同一張發票
 * - 查詢區間：上次成功查到的日期往前 3 天（發票上傳最慢約 48 小時）到今天；第一次查最近 60 天
 * - 伺服器未設定 AppID 時不執行，畫面上改提供 QR Code 掃描與 CSV 匯入
 */
import { db } from '@/db/schema';
import { addDays, todayKey } from '@/domain/period';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { api } from './api';
import { importInvoices, type Invoice, type InvoiceImportResult } from './einvoice';

const META_LAST_DATE = 'einvoice.lastDate';
const META_LAST_RUN = 'einvoice.lastRunAt';
const RUN_INTERVAL = 6 * 3600 * 1000;
export const CARD_NO_RE = /^\/[0-9A-Z.+-]{7}$/;

interface ServerInvoice {
  number: string; date: string; time: string; seller_name: string; seller_ban: string; amount: number; status: string;
  items: { name: string; quantity: string; unit_price: string; amount: string }[];
}

let statusCache: { configured: boolean; message: string } | null = null;

export async function carrierServerStatus(): Promise<{ configured: boolean; message: string }> {
  if (!AUTH_ENABLED) return { configured: false, message: '需要啟用帳號系統與自架伺服器' };
  statusCache ??= await api<{ configured: boolean; message: string }>('/einvoice/status').catch(() => ({ configured: false, message: '無法連線到伺服器' }));
  return statusCache;
}

export async function fetchCarrierInvoices(start: string, end: string): Promise<Invoice[]> {
  const { cardNo, verifyCode } = useSettings.getState().einvoice;
  const r = await api<{ invoices: ServerInvoice[] }>('/einvoice/carrier', {
    method: 'POST', body: { card_no: cardNo, verify_code: verifyCode, start, end, details: true },
  });
  return r.invoices.map((i) => ({
    number: i.number, date: i.date, time: i.time, amount: i.amount, sellerId: i.seller_ban, sellerName: i.seller_name, status: i.status || '開立',
    items: i.items.map((x) => ({ name: x.name, qty: Number(x.quantity) || undefined, price: Number(x.unit_price) || undefined, amount: Number(x.amount) || undefined })),
  }));
}

export interface CarrierSyncResult extends InvoiceImportResult { fetched: number; start: string; end: string }

/** 抓取並記帳；force=true 時忽略 6 小時間隔（設定頁「立即同步」） */
export async function syncCarrier(opts: { force?: boolean; days?: number } = {}): Promise<CarrierSyncResult | null> {
  const cfg = useSettings.getState().einvoice;
  if (!CARD_NO_RE.test(cfg.cardNo) || !cfg.verifyCode) return null;
  if (!opts.force) {
    if (!cfg.autoSync) return null;
    const last = (await db.meta.get(META_LAST_RUN))?.value as number | undefined;
    if (last && Date.now() - last < RUN_INTERVAL) return null;
  }
  if (!(await carrierServerStatus()).configured) return null;
  // 先同步，確保其他裝置記過的發票號碼已在本機（避免重複記帳）
  const { syncNow, useSync } = await import('./sync');
  await syncNow();
  if (useSync.getState().phase !== 'idle') throw new Error('尚未完成跨裝置同步，稍後再試');
  const end = todayKey();
  const lastDate = (await db.meta.get(META_LAST_DATE))?.value as string | undefined;
  const start = opts.days ? addDays(end, -opts.days) : lastDate ? addDays(lastDate, -3) : addDays(end, -60);
  const list = await fetchCarrierInvoices(start, end);
  const r = await importInvoices(list, { defaultAccountId: cfg.defaultAccountId });
  await db.meta.bulkPut([{ key: META_LAST_DATE, value: end }, { key: META_LAST_RUN, value: Date.now() }]);
  return { ...r, fetched: list.length, start, end };
}

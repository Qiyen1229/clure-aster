/**
 * 台灣電子發票：
 * 1. 紙本發票左側 QR Code（財政部電子發票 QR Code 規格）：
 *    發票字軌(10) 開立日期民國 yyyMMdd(7) 隨機碼(4) 銷售額16進位(8) 總計額16進位(8) 買方統編(8) 賣方統編(8) 加密驗證(24)
 *    之後以「:」分隔：營業人自用區 : 品目筆數 : 總品目筆數 : 中文編碼(0=Big5 1=UTF-8 2=Base64) : 品名:數量:單價 …
 *    右側 QR Code 以「**」開頭，只有品目延續，沒有金額。
 * 2. 財政部「手機條碼載具」消費明細 CSV：以 | 分隔的 M（發票）／D（明細）列；也接受一般 CSV（含「發票號碼」「總金額」欄）。
 */
import { normDate } from './importer';
import { parseCSV, detectDelimiter } from './csv';

export interface InvoiceItem { name: string; qty?: number; price?: number; amount?: number }
export interface Invoice {
  number: string;
  date: string;
  /** 總金額（含稅，元） */
  amount: number;
  sellerId: string;
  sellerName: string;
  status: string;
  items: InvoiceItem[];
}

const rocToIso = (s: string) => normDate(s);

/** 解析紙本發票左側 QR Code 的文字。bytes 提供時可解 Big5 品名。右側 QR（** 開頭）回傳 null。 */
export function parseInvoiceQR(text: string, bytes?: Uint8Array): Invoice | null {
  const t = text.trim();
  if (t.startsWith('**') || t.length < 77) return null;
  const number = t.slice(0, 10);
  if (!/^[A-Z]{2}\d{8}$/.test(number)) return null;
  const date = rocToIso(t.slice(10, 17));
  const total = parseInt(t.slice(29, 37), 16);
  if (!date || !Number.isFinite(total)) return null;
  const sellerId = t.slice(45, 53);
  const items: InvoiceItem[] = [];
  const rest = t.slice(77);
  if (rest.startsWith(':')) {
    const parts = rest.slice(1).split(':');
    const enc = parts[3];
    let fields = parts.slice(4);
    if (enc === '0' && bytes) {
      // Big5：用原始位元組重新解碼後再切欄位
      try {
        const decoded = new TextDecoder('big5').decode(bytes);
        fields = decoded.slice(77).slice(1).split(':').slice(4);
      } catch { /* 瀏覽器不支援 Big5 時保留原字串 */ }
    } else if (enc === '2') {
      try {
        fields = new TextDecoder('utf-8').decode(Uint8Array.from(atob(fields.join(':')), (c) => c.charCodeAt(0))).split(':');
      } catch { fields = []; }
    }
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const name = fields[i].trim();
      if (!name) continue;
      const qty = Number(fields[i + 1]), price = Number(fields[i + 2]);
      items.push({ name, qty: Number.isFinite(qty) ? qty : undefined, price: Number.isFinite(price) ? price : undefined });
    }
  }
  return { number, date, amount: total, sellerId: /^\d{8}$/.test(sellerId) ? sellerId : '', sellerName: '', status: '開立', items };
}

/** 解析載具消費明細（M／D 列或一般 CSV） */
export function parseEinvoiceCsv(text: string): Invoice[] {
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim());
  const pipe = lines.some((l) => /^(M|D)\|/.test(l.trim()));
  if (pipe) {
    const map = new Map<string, Invoice>();
    for (const raw of lines) {
      const f = raw.trim().split('|').map((x) => x.trim());
      if (f[0] === 'M' && f.length >= 9) {
        // M|載具名稱|載具號碼|發票日期|商店統編|商店店名|發票號碼|總金額|發票狀態
        const date = rocToIso(f[3]);
        if (!date) continue;
        map.set(f[6], { number: f[6], date, sellerId: f[4], sellerName: f[5], amount: Number(f[7].replace(/,/g, '')), status: f[8] || '開立', items: [] });
      } else if (f[0] === 'D' && f.length >= 4) {
        // D|發票號碼|小計|品項名稱
        const inv = map.get(f[1]);
        if (inv) inv.items.push({ name: f[3], amount: Number(f[2].replace(/,/g, '')) });
      }
    }
    return [...map.values()].filter((i) => Number.isFinite(i.amount));
  }
  // 一般 CSV：依標題找欄位
  const rows = parseCSV(clean, detectDelimiter(clean));
  const head = rows[0]?.map((h) => h.trim()) ?? [];
  const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const iNo = col('發票號碼'), iDate = col('發票日期', '日期'), iAmt = col('總金額', '金額'), iSeller = col('商店店名', '賣方名稱', '店名'),
    iSellerId = col('商店統編', '賣方統編'), iStatus = col('發票狀態', '狀態'), iItem = col('品項名稱', '品名');
  if (iNo < 0 || iDate < 0 || iAmt < 0) return [];
  const map = new Map<string, Invoice>();
  for (const r of rows.slice(1)) {
    const no = (r[iNo] ?? '').trim();
    const date = rocToIso(r[iDate] ?? '');
    if (!/^[A-Z]{2}-?\d{8}$/.test(no) || !date) continue;
    const key = no.replace('-', '');
    let inv = map.get(key);
    if (!inv) {
      inv = { number: key, date, amount: Number((r[iAmt] ?? '').replace(/,/g, '')), sellerId: iSellerId >= 0 ? r[iSellerId] ?? '' : '',
        sellerName: iSeller >= 0 ? r[iSeller] ?? '' : '', status: iStatus >= 0 ? r[iStatus] || '開立' : '開立', items: [] };
      map.set(key, inv);
    }
    if (iItem >= 0 && r[iItem]) inv.items.push({ name: r[iItem] });
  }
  return [...map.values()].filter((i) => Number.isFinite(i.amount));
}

/** 發票是否作廢／折讓（不入帳） */
export const isVoided = (inv: Invoice) => /作廢|註銷|退回/.test(inv.status);

/** 給記帳用的簡短備註：前 3 個品名 */
export function invoiceNote(inv: Invoice): string {
  const names = inv.items.map((i) => i.name).filter(Boolean);
  const head = names.slice(0, 3).join('、');
  return names.length > 3 ? `${head} 等 ${names.length} 項` : head;
}

/** 從圖片解讀 QR Code：整張 → 左半 → 右半（紙本發票有兩個 QR，左邊才有金額） */
export async function scanInvoiceImage(file: Blob): Promise<{ invoice: Invoice | null; raw: string | null }> {
  const { default: jsQR } = await import('jsqr');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const regions = [[0, 0, w, h], [0, 0, Math.ceil(w * 0.6), h], [Math.floor(w * 0.4), 0, Math.ceil(w * 0.6), h]];
  let raw: string | null = null;
  for (const [x, y, rw, rh] of regions) {
    const img = ctx.getImageData(x, y, rw, rh);
    const code = jsQR(img.data, rw, rh, { inversionAttempts: 'attemptBoth' });
    if (!code) continue;
    raw ??= code.data;
    const inv = parseInvoiceQR(code.data, Uint8Array.from(code.binaryData));
    if (inv) return { invoice: inv, raw: code.data };
  }
  return { invoice: null, raw };
}

/** 已記帳的發票號碼（避免重複匯入） */
export async function existingInvoiceNos(numbers: string[]): Promise<Set<string>> {
  const { db } = await import('@/db/schema');
  const rows = await db.transactions.where('invoiceNo').anyOf(numbers).toArray();
  return new Set(rows.filter((t) => !t.deletedAt).map((t) => t.invoiceNo!));
}

/** 批次把發票記成支出：分類依自動分類規則／商家記憶，找不到則記「其他支出」 */
export async function importInvoices(list: Invoice[], accountId: string, currency: string): Promise<number> {
  const [{ addTransaction }, { suggestCategory }, { toMinor }] = await Promise.all([
    import('@/db/repo/ledger'), import('./autocat'), import('@/domain/money'),
  ]);
  const done = await existingInvoiceNos(list.map((i) => i.number));
  let n = 0;
  for (const inv of list) {
    if (done.has(inv.number) || isVoided(inv) || !(inv.amount > 0)) continue;
    const note = invoiceNote(inv) || inv.sellerName;
    const sug = await suggestCategory([inv.sellerName, note].filter(Boolean).join(' '), 'expense');
    await addTransaction({
      type: 'expense', accountId, categoryId: sug?.categoryId ?? 'exp-other_exp', amountMinor: toMinor(inv.amount, currency), currency,
      date: inv.date, ts: new Date(`${inv.date}T12:00:00`).getTime(), note, merchant: inv.sellerName || undefined, invoiceNo: inv.number,
      tagIds: sug?.tagIds ?? [],
    });
    done.add(inv.number);
    n++;
  }
  return n;
}

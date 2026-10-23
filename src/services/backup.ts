/**
 * 備份／還原與匯出：
 * - JSON 完整備份：所有資料表（含收據照片，以 base64 內嵌）
 * - 還原：取代全部 或 合併（以 id 覆蓋）
 * - CSV（帳目＋轉帳）、Excel（帳目／帳戶／投資交易／股利 多工作表）
 * - 儲存：桌機用 File System Access API；iPhone 用分享表單（可存到「檔案」或 iCloud Drive）；否則下載
 */
import { db } from '@/db/schema';
import type { Account, Category, Transaction, Transfer } from '@/db/types';
import { recomputeBalances } from '@/db/repo/accounts';
import { fromMinor } from '@/domain/money';
import { toCSV } from './csv';
import { getSetting } from '@/db/repo/settings';
import { buildXlsx } from './xlsx';

const BACKUP_FORMAT = 1;

async function blobToB64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBlob(b64: string, type: string): Blob {
  return new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type });
}

export async function buildBackup(includePhotos = true): Promise<Blob> {
  const data: Record<string, unknown[]> = {};
  for (const t of db.tables) {
    if (t.name === 'attachments') {
      if (!includePhotos) continue;
      const rows = await t.toArray();
      data.attachments = await Promise.all(rows.map(async (a: any) => ({ ...a, blob: await blobToB64(a.blob), thumb: await blobToB64(a.thumb) })));
    } else {
      data[t.name] = await t.toArray();
    }
  }
  const payload = { app: 'clure', format: BACKUP_FORMAT, version: __APP_VERSION__, schema: db.verno, exportedAt: new Date().toISOString(), data };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export interface RestoreSummary { tables: number; rows: number }

export async function restoreBackup(file: File, mode: 'replace' | 'merge'): Promise<RestoreSummary> {
  const json = JSON.parse(await file.text());
  if (json.app !== 'clure' || !json.data) throw new Error('不是 Clure 的備份檔');
  if (json.schema > db.verno) throw new Error('備份檔來自較新版本，請先更新 App');
  let rows = 0, tables = 0;
  const names = db.tables.map((t) => t.name);
  await db.transaction('rw', db.tables, async () => {
    for (const name of names) {
      const list = json.data[name] as any[] | undefined;
      const table = db.table(name);
      if (mode === 'replace') await table.clear();
      if (!list?.length) continue;
      const fixed = name === 'attachments'
        ? list.map((a) => ({ ...a, blob: b64ToBlob(a.blob, a.mime || 'image/jpeg'), thumb: b64ToBlob(a.thumb, 'image/jpeg') }))
        : list;
      await table.bulkPut(fixed);
      rows += fixed.length;
      tables++;
    }
  });
  await recomputeBalances(true);
  await db.meta.put({ key: 'lastRestoreAt', value: Date.now() });
  return { tables, rows };
}

/** 儲存檔案：桌機另存新檔 → 行動裝置分享表單 → 下載 */
export async function saveFile(blob: Blob, filename: string, mime: string): Promise<'saved' | 'shared' | 'downloaded' | 'cancelled'> {
  const w = window as any;
  if (w.showSaveFilePicker && !/iPhone|iPad|Android/.test(navigator.userAgent)) {
    try {
      const ext = filename.split('.').pop();
      const handle = await w.showSaveFilePicker({ suggestedName: filename, types: [{ description: filename, accept: { [mime]: [`.${ext}`] } }] });
      const ws = await handle.createWritable();
      await ws.write(blob);
      await ws.close();
      return 'saved';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const file = new File([blob], filename, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'downloaded';
}

export async function exportBackup(includePhotos = true) {
  const blob = await buildBackup(includePhotos);
  const r = await saveFile(blob, `clure-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  if (r !== 'cancelled') await db.meta.put({ key: 'lastBackupAt', value: Date.now() });
  return r;
}

// ───── 帳目表格 ─────

const TYPE_LABEL: Record<string, string> = { expense: '支出', income: '收入', adjust: '餘額調整', transfer_fee: '手續費', transfer: '轉帳' };

export interface ExportScope { start?: string; end?: string; projectId?: string }

async function ledgerRows(scope: ExportScope) {
  const [txs, trs, accounts, cats, tags, projects, base] = await Promise.all([
    db.transactions.toArray(), db.transfers.toArray(), db.accounts.toArray(), db.categories.toArray(), db.tags.toArray(), db.projects.toArray(),
    getSetting('baseCurrency'),
  ]);
  const acc = new Map<string, Account>(accounts.map((a) => [a.id, a]));
  const cat = new Map<string, Category>(cats.map((c) => [c.id, c]));
  const tag = new Map(tags.map((t) => [t.id, t.name]));
  const proj = new Map(projects.map((p) => [p.id, p.name]));
  const inScope = (x: { date: string; deletedAt?: number | null; projectId?: string }) =>
    !x.deletedAt && (!scope.start || x.date >= scope.start) && (!scope.end || x.date <= scope.end) && (!scope.projectId || x.projectId === scope.projectId);
  const header = ['日期', '時間', '類型', '主分類', '子分類', '金額', '幣別', '帳戶', '轉入帳戶', '轉入金額', '手續費', '主幣別金額', '備註', '標籤', '專案'];
  const out: (string | number)[][] = [];
  const time = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
  for (const t of txs.filter(inScope) as Transaction[]) {
    if (t.transferId) continue;
    const c = cat.get(t.categoryId);
    const main = c?.parentId ? cat.get(c.parentId)?.name : c?.name;
    out.push([
      t.date, time(t.ts), TYPE_LABEL[t.type], main ?? '', c?.parentId ? c.name : '',
      Number(fromMinor(t.type === 'expense' || t.type === 'transfer_fee' ? -t.amountMinor : t.amountMinor, t.currency)), t.currency,
      acc.get(t.accountId)?.name ?? '', '', '', '', Number(fromMinor(t.baseAmountMinor, base)),
      t.note, t.tagIds.map((x) => tag.get(x)).filter(Boolean).join('|'), t.projectId ? proj.get(t.projectId) ?? '' : '',
    ]);
  }
  for (const tr of trs.filter(inScope) as Transfer[]) {
    const from = acc.get(tr.fromAccountId);
    const to = acc.get(tr.toAccountId);
    out.push([
      tr.date, time(tr.ts), '轉帳', '', '', Number(fromMinor(-tr.fromAmountMinor, from?.currency ?? 'TWD')), from?.currency ?? '',
      from?.name ?? '', to?.name ?? '', Number(fromMinor(tr.toAmountMinor, to?.currency ?? 'TWD')), Number(fromMinor(tr.feeMinor, from?.currency ?? 'TWD')), '',
      tr.note, tr.tagIds.map((x) => tag.get(x)).filter(Boolean).join('|'), tr.projectId ? proj.get(tr.projectId) ?? '' : '',
    ]);
  }
  out.sort((a, b) => `${b[0]}${b[1]}`.localeCompare(`${a[0]}${a[1]}`));
  return [header, ...out];
}

export async function exportCSV(scope: ExportScope = {}, name = 'clure-transactions') {
  const rows = await ledgerRows(scope);
  return saveFile(new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8' }), `${name}.csv`, 'text/csv');
}

export async function exportXLSX(scope: ExportScope = {}, name = 'clure') {
  const [rows, accounts, stocks, trades, divs] = await Promise.all([
    ledgerRows(scope), db.accounts.toArray(), db.stocks.toArray(), db.stock_trades.toArray(), db.dividends.toArray(),
  ]);
  const stockMap = new Map(stocks.map((s) => [s.id, s]));
  const data = buildXlsx([
    { name: '帳目', rows, widths: [12, 7, 9, 10, 10, 12, 6, 14, 14, 12, 9, 12, 28, 16, 12] },
    {
      name: '帳戶', widths: [18, 10, 6, 14, 10, 8],
      rows: [['名稱', '類型', '幣別', '餘額', '計入淨資產', '封存'], ...accounts.map((a) => [a.name, a.type, a.currency, Number(fromMinor(a.balanceMinor, a.currency)), a.includeInNetWorth ? '是' : '否', a.archived ? '是' : '否'])],
    },
    {
      name: '投資交易', widths: [12, 10, 16, 8, 10, 10, 10, 10, 8],
      rows: [['日期', '代號', '名稱', '類型', '股數', '價格', '手續費', '交易稅', '匯率'],
        ...trades.filter((t) => !t.deletedAt).map((t) => {
          const s = stockMap.get(t.stockId);
          return [t.date, s?.symbol ?? '', s?.name ?? '', t.type, Number(t.sharesDec), Number(t.priceDec), Number(fromMinor(t.feeMinor, s?.currency ?? 'TWD')), Number(fromMinor(t.taxMinor, s?.currency ?? 'TWD')), Number(t.fxRateDec)];
        })],
    },
    {
      name: '股利', widths: [12, 12, 10, 16, 8, 10, 12, 12],
      rows: [['除息日', '發放日', '代號', '名稱', '種類', '每股', '總額', '淨額'],
        ...divs.map((d) => {
          const s = stockMap.get(d.stockId);
          return [d.exDate, d.payDate, s?.symbol ?? '', s?.name ?? '', d.kind === 'cash' ? '現金' : '股票', Number(d.perShareDec), Number(fromMinor(d.grossMinor, d.currency)), Number(fromMinor(d.netMinor, d.currency))];
        })],
    },
  ]);
  return saveFile(new Blob([data as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${name}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

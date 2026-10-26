/**
 * 帳目／轉帳存取層：所有會影響帳戶餘額的寫入都必須經過這裡，
 * 並在同一個 IndexedDB 交易中更新 accounts.balanceMinor，確保「帳目 ↔ 餘額」永遠一致。
 */
import Dexie from 'dexie';
import { db, uid } from '../schema';
import type { Transaction, Transfer, TxType } from '../types';
import { convertMinor } from '@/domain/money';
import { transferEffects, txEffect } from '@/domain/ledger';
import { getRate } from '@/services/fx';
import { getSetting } from './settings';

export interface TxInput {
  type: TxType;
  accountId: string;
  categoryId: string;
  amountMinor: number;
  currency: string;
  /** 原幣→帳戶幣別匯率；未給時自動取用匯率表 */
  fxRateDec?: string;
  date: string;
  ts: number;
  note?: string;
  merchant?: string;
  invoiceNo?: string;
  tagIds?: string[];
  projectId?: string;
  attachmentIds?: string[];
  isSample?: boolean;
  excludeFromBudget?: boolean;
  excludeFromStats?: boolean;
  transferId?: string;
  recurringRuleId?: string;
  installmentId?: string;
  installmentNo?: number;
  stockTradeId?: string;
  dividendId?: string;
  split?: Transaction['split'];
}

/**
 * 調整帳戶快取餘額。刻意寫成 Dexie Promise 鏈（非 async function），
 * 減少原生 await 巢狀層數，避免 IndexedDB 交易在巢狀呼叫中提前提交（PrematureCommitError）。
 */
function bump(accountId: string, delta: number): Promise<unknown> {
  if (delta === 0) return Dexie.Promise.resolve();
  return db.accounts.get(accountId).then((acc) => {
    if (!acc) throw new Error(`找不到帳戶 ${accountId}`);
    const next = acc.balanceMinor + delta;
    if (!Number.isSafeInteger(next)) throw new RangeError('帳戶餘額超出範圍');
    return db.accounts.update(accountId, { balanceMinor: next, updatedAt: Date.now() });
  });
}

/** 依帳戶幣別、主幣別換算金額 */
async function resolveAmounts(input: TxInput): Promise<Pick<Transaction, 'accountAmountMinor' | 'baseAmountMinor' | 'fxRateDec'>> {
  const acc = await db.accounts.get(input.accountId);
  if (!acc) throw new Error('帳戶不存在');
  const base = await getSetting('baseCurrency');
  let fxRateDec = input.fxRateDec;
  if (input.currency !== acc.currency && !fxRateDec) {
    const r = await getRate(input.currency, acc.currency);
    if (!r) throw new Error(`缺少 ${input.currency}→${acc.currency} 匯率，請手動輸入`);
    fxRateDec = r.toString();
  }
  const accountAmountMinor = input.currency === acc.currency
    ? input.amountMinor
    : convertMinor(input.amountMinor, input.currency, acc.currency, fxRateDec!);
  let baseAmountMinor = accountAmountMinor;
  if (acc.currency !== base) {
    const r = await getRate(acc.currency, base);
    // 無法取得匯率時暫以 1 計，資料健康檢查會在有匯率後重算
    baseAmountMinor = convertMinor(accountAmountMinor, acc.currency, base, r ?? 1);
  }
  return {
    accountAmountMinor,
    baseAmountMinor: input.type === 'adjust' ? baseAmountMinor : Math.abs(baseAmountMinor),
    fxRateDec: input.currency === acc.currency ? undefined : fxRateDec,
  };
}

function toRow(id: string, input: TxInput, amounts: Awaited<ReturnType<typeof resolveAmounts>>, createdAt: number): Transaction {
  return {
    id,
    type: input.type,
    accountId: input.accountId,
    categoryId: input.categoryId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    ...amounts,
    date: input.date,
    ts: input.ts,
    note: input.note ?? '',
    merchant: input.merchant || undefined,
    invoiceNo: input.invoiceNo || undefined,
    tagIds: input.tagIds ?? [],
    projectId: input.projectId || undefined,
    attachmentIds: input.attachmentIds ?? [],
    transferId: input.transferId,
    recurringRuleId: input.recurringRuleId,
    installmentId: input.installmentId,
    installmentNo: input.installmentNo,
    stockTradeId: input.stockTradeId,
    dividendId: input.dividendId,
    split: input.split,
    isSample: input.isSample,
    excludeFromBudget: input.excludeFromBudget,
    excludeFromStats: input.excludeFromStats ?? input.type === 'adjust',
    createdAt,
    updatedAt: Date.now(),
  };
}

export async function addTransaction(input: TxInput): Promise<Transaction> {
  const amounts = await resolveAmounts(input);
  const row = toRow(uid(), input, amounts, Date.now());
  await db.transaction('rw', db.transactions, db.accounts, db.attachments, async () => {
    await db.transactions.add(row);
    await bump(row.accountId, txEffect(row));
    for (const aid of row.attachmentIds) await db.attachments.update(aid, { transactionId: row.id });
  });
  return row;
}

export async function updateTransaction(id: string, input: TxInput): Promise<Transaction> {
  const amounts = await resolveAmounts(input);
  let saved!: Transaction;
  await db.transaction('rw', db.transactions, db.accounts, db.attachments, async () => {
    const old = await db.transactions.get(id);
    if (!old) throw new Error('帳目不存在');
    // 只覆蓋有給值的欄位，保留週期／分期／股票等來源關聯；專案可被清除
    const row = Object.fromEntries(Object.entries(toRow(id, input, amounts, old.createdAt)).filter(([, v]) => v !== undefined));
    saved = { ...old, ...row, projectId: input.projectId || undefined, fxRateDec: amounts.fxRateDec } as Transaction;
    if (!old.deletedAt) await bump(old.accountId, -txEffect(old));
    await db.transactions.put(saved);
    await bump(saved.accountId, txEffect(saved));
    // 移除的附件一併刪除
    const removed = old.attachmentIds.filter((a) => !saved.attachmentIds.includes(a));
    if (removed.length) await db.attachments.bulkDelete(removed);
    for (const aid of saved.attachmentIds) await db.attachments.update(aid, { transactionId: id });
  });
  return saved;
}

/** 軟刪除（可復原）。轉帳手續費帳目會連同整筆轉帳一起刪除。 */
export async function deleteTransactions(ids: string[]): Promise<void> {
  await db.transaction('rw', db.transactions, db.transfers, db.accounts, async () => {
    const now = Date.now();
    for (const id of ids) {
      const tx = await db.transactions.get(id);
      if (!tx || tx.deletedAt) continue;
      if (tx.transferId) {
        await deleteTransfersInner([tx.transferId], now);
        continue;
      }
      await db.transactions.update(id, { deletedAt: now });
      await bump(tx.accountId, -txEffect(tx));
    }
  });
}

export async function restoreTransactions(ids: string[]): Promise<void> {
  await db.transaction('rw', db.transactions, db.transfers, db.accounts, async () => {
    for (const id of ids) {
      const tx = await db.transactions.get(id);
      if (!tx || !tx.deletedAt) continue;
      if (tx.transferId) {
        await restoreTransfersInner([tx.transferId]);
        continue;
      }
      await db.transactions.update(id, { deletedAt: null });
      await bump(tx.accountId, txEffect(tx));
    }
  });
}

/** 批次修改（分類、帳戶、日期…）；帳戶變更時一併搬移餘額影響 */
export async function batchUpdate(ids: string[], patch: Partial<Pick<Transaction, 'categoryId' | 'accountId' | 'date' | 'projectId' | 'tagIds'>>): Promise<void> {
  await db.transaction('rw', db.transactions, db.accounts, async () => {
    for (const id of ids) {
      const tx = await db.transactions.get(id);
      if (!tx || tx.deletedAt || tx.transferId) continue;
      if (patch.accountId && patch.accountId !== tx.accountId) {
        const [from, to] = await Promise.all([db.accounts.get(tx.accountId), db.accounts.get(patch.accountId)]);
        // 跨幣別帳戶間批次搬移會改變金額語意，跳過以保資料正確
        if (!from || !to || from.currency !== to.currency) continue;
        await bump(tx.accountId, -txEffect(tx));
        await bump(patch.accountId, txEffect(tx));
      }
      await db.transactions.update(id, { ...patch, updatedAt: Date.now() });
    }
  });
}

// ───────────── 轉帳 ─────────────

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  fromAmountMinor: number;
  toAmountMinor: number;
  fxRateDec?: string;
  feeMinor: number;
  date: string;
  ts: number;
  note?: string;
  tagIds?: string[];
  projectId?: string;
  isSample?: boolean;
}

type FeeAmounts = Awaited<ReturnType<typeof resolveAmounts>> | null;

/** 手續費金額需在 DB 交易外先算好（取匯率可能需要連網，不能在 IndexedDB 交易中 await 網路） */
async function feeAmountsFor(input: TransferInput): Promise<FeeAmounts> {
  if (input.feeMinor <= 0) return null;
  const from = await db.accounts.get(input.fromAccountId);
  if (!from) throw new Error('轉出帳戶不存在');
  return resolveAmounts({
    type: 'transfer_fee', accountId: from.id, categoryId: 'sys-transfer-fee', amountMinor: input.feeMinor,
    currency: from.currency, date: input.date, ts: input.ts,
  });
}

async function writeTransfer(id: string, input: TransferInput, createdAt: number, feeAmounts: FeeAmounts): Promise<Transfer> {
  const tr: Transfer = {
    id,
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    fromAmountMinor: input.fromAmountMinor,
    toAmountMinor: input.toAmountMinor,
    fxRateDec: input.fxRateDec,
    feeMinor: input.feeMinor,
    feeAccountId: input.feeMinor > 0 ? input.fromAccountId : undefined,
    date: input.date,
    ts: input.ts,
    note: input.note ?? '',
    tagIds: input.tagIds ?? [],
    projectId: input.projectId || undefined,
    isSample: input.isSample,
    createdAt,
    updatedAt: Date.now(),
  };
  for (const [acc, delta] of transferEffects(tr)) await bump(acc, delta);
  if (tr.feeMinor > 0 && feeAmounts) {
    const from = (await db.accounts.get(tr.fromAccountId))!;
    const feeTx = toRow(uid(), {
      type: 'transfer_fee', accountId: tr.fromAccountId, categoryId: 'sys-transfer-fee',
      amountMinor: tr.feeMinor, currency: from.currency, date: tr.date, ts: tr.ts,
      note: '轉帳手續費', transferId: id, isSample: input.isSample,
    }, feeAmounts, Date.now());
    tr.feeTransactionId = feeTx.id;
    await db.transactions.add(feeTx);
    await bump(feeTx.accountId, txEffect(feeTx));
  }
  await db.transfers.put(tr);
  return tr;
}

export async function addTransfer(input: TransferInput): Promise<Transfer> {
  if (input.fromAccountId === input.toAccountId) throw new Error('轉出與轉入帳戶不能相同');
  const fee = await feeAmountsFor(input);
  let tr!: Transfer;
  await db.transaction('rw', db.transfers, db.transactions, db.accounts, async () => {
    tr = await writeTransfer(uid(), input, Date.now(), fee);
  });
  return tr;
}

export async function updateTransfer(id: string, input: TransferInput): Promise<Transfer> {
  if (input.fromAccountId === input.toAccountId) throw new Error('轉出與轉入帳戶不能相同');
  const fee = await feeAmountsFor(input);
  let tr!: Transfer;
  await db.transaction('rw', db.transfers, db.transactions, db.accounts, async () => {
    const old = await db.transfers.get(id);
    if (!old) throw new Error('轉帳不存在');
    await revertTransfer(old);
    if (old.feeTransactionId) await db.transactions.delete(old.feeTransactionId);
    tr = await writeTransfer(id, input, old.createdAt, fee);
  });
  return tr;
}

async function revertTransfer(tr: Transfer): Promise<void> {
  if (tr.deletedAt) return;
  for (const [acc, delta] of transferEffects(tr)) await bump(acc, -delta);
  if (tr.feeTransactionId) {
    const fee = await db.transactions.get(tr.feeTransactionId);
    if (fee && !fee.deletedAt) await bump(fee.accountId, -txEffect(fee));
  }
}

async function deleteTransfersInner(ids: string[], now: number): Promise<void> {
  for (const id of ids) {
    const tr = await db.transfers.get(id);
    if (!tr || tr.deletedAt) continue;
    await revertTransfer(tr);
    await db.transfers.update(id, { deletedAt: now });
    if (tr.feeTransactionId) await db.transactions.update(tr.feeTransactionId, { deletedAt: now });
  }
}

async function restoreTransfersInner(ids: string[]): Promise<void> {
  for (const id of ids) {
    const tr = await db.transfers.get(id);
    if (!tr || !tr.deletedAt) continue;
    for (const [acc, delta] of transferEffects(tr)) await bump(acc, delta);
    await db.transfers.update(id, { deletedAt: null });
    if (tr.feeTransactionId) {
      const fee = await db.transactions.get(tr.feeTransactionId);
      if (fee) {
        await db.transactions.update(fee.id, { deletedAt: null });
        await bump(fee.accountId, txEffect(fee));
      }
    }
  }
}

export async function deleteTransfers(ids: string[]): Promise<void> {
  await db.transaction('rw', db.transfers, db.transactions, db.accounts, () => deleteTransfersInner(ids, Date.now()));
}

export async function restoreTransfers(ids: string[]): Promise<void> {
  await db.transaction('rw', db.transfers, db.transactions, db.accounts, () => restoreTransfersInner(ids));
}

// ───────────── 查詢 ─────────────

export type LedgerItem =
  | { kind: 'tx'; id: string; date: string; ts: number; tx: Transaction }
  | { kind: 'transfer'; id: string; date: string; ts: number; tr: Transfer };

/** 期間內的帳目＋轉帳（已排除軟刪除、排除轉帳手續費的獨立列），新到舊排序 */
export async function listLedger(start: string, end: string, accountId?: string): Promise<LedgerItem[]> {
  const [txs, trs] = await Promise.all([
    accountId
      ? db.transactions.where('[accountId+date]').between([accountId, start], [accountId, end], true, true).toArray()
      : db.transactions.where('date').between(start, end, true, true).toArray(),
    db.transfers.where('date').between(start, end, true, true).toArray(),
  ]);
  const items: LedgerItem[] = [];
  for (const tx of txs) if (!tx.deletedAt && !tx.transferId) items.push({ kind: 'tx', id: tx.id, date: tx.date, ts: tx.ts, tx });
  for (const tr of trs) {
    if (tr.deletedAt) continue;
    if (accountId && tr.fromAccountId !== accountId && tr.toAccountId !== accountId) continue;
    items.push({ kind: 'transfer', id: tr.id, date: tr.date, ts: tr.ts, tr });
  }
  return items.sort((a, b) => (a.date === b.date ? b.ts - a.ts : a.date < b.date ? 1 : -1));
}

/** 期間內計入統計的帳目（含轉帳手續費），報表／小計用 */
export async function listStatTxs(start: string, end: string): Promise<Transaction[]> {
  const txs = await db.transactions.where('date').between(start, end, true, true).toArray();
  return txs.filter((t) => !t.deletedAt);
}

/** 最近一筆（複製上一筆用） */
export async function lastTransaction(): Promise<Transaction | undefined> {
  const recent = await db.transactions.orderBy('ts').reverse().limit(20).toArray();
  return recent.find((t) => !t.deletedAt && (t.type === 'expense' || t.type === 'income'));
}

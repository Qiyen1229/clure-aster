/**
 * 資料健康檢查與修復。每一項都先「檢查」列出問題，使用者確認後才「修復」。
 */
import { db } from '@/db/schema';
import { recomputeBalances } from '@/db/repo/accounts';
import { convertMinor } from '@/domain/money';
import { resolveRate } from './fx';
import { getSetting } from '@/db/repo/settings';

export interface HealthIssue {
  id: 'balances' | 'base_amounts' | 'orphan_refs' | 'orphan_attachments' | 'purge_deleted' | 'stale_pending';
  title: string;
  detail: string;
  count: number;
  fix: () => Promise<string>;
}

const PURGE_DAYS = 30;

export async function runHealthCheck(): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];

  const diffs = await recomputeBalances(false);
  if (diffs.length) issues.push({
    id: 'balances', title: '帳戶餘額與帳目不一致', count: diffs.length,
    detail: diffs.map((d) => d.name).join('、'),
    fix: async () => `已修正 ${(await recomputeBalances(true)).length} 個帳戶`,
  });

  // 主幣別金額：帳戶幣別＝主幣別者應與帳戶金額相同；外幣以目前匯率重算
  const base = await getSetting('baseCurrency');
  const [accounts, rates] = await Promise.all([db.accounts.toArray(), db.exchange_rates.toArray()]);
  const accCur = new Map(accounts.map((a) => [a.id, a.currency]));
  const rateMap = new Map(rates.map((r) => [`${r.base}>${r.quote}`, r]));
  const wrong: { id: string; v: number }[] = [];
  await db.transactions.each((t) => {
    const cur = accCur.get(t.accountId);
    if (!cur) return;
    let expected: number | null;
    if (cur === base) expected = t.accountAmountMinor;
    else {
      const r = resolveRate(rateMap, cur, base);
      expected = r ? convertMinor(t.accountAmountMinor, cur, base, r) : null;
      // 外幣只修正「明顯錯誤」（例如變更主幣別後仍是舊值、或當初缺匯率以 1 計）
      if (expected !== null && Math.abs(Math.abs(expected) - Math.abs(t.baseAmountMinor)) <= Math.abs(expected) * 0.2) expected = null;
    }
    if (expected === null) return;
    const v = t.type === 'adjust' ? expected : Math.abs(expected);
    if (v !== t.baseAmountMinor) wrong.push({ id: t.id, v });
  });
  if (wrong.length) issues.push({
    id: 'base_amounts', title: '主幣別換算金額需要更新', count: wrong.length,
    detail: '通常發生在變更主幣別、或記帳當下缺少匯率時。將以目前匯率重新換算。',
    fix: async () => {
      await db.transaction('rw', db.transactions, async () => { for (const w of wrong) await db.transactions.update(w.id, { baseAmountMinor: w.v }); });
      return `已更新 ${wrong.length} 筆`;
    },
  });

  // 參照不存在的帳戶或分類
  const catIds = new Set(await db.categories.toCollection().primaryKeys());
  const accIds = new Set(accounts.map((a) => a.id));
  const badAcc: string[] = [];
  const badCat: string[] = [];
  await db.transactions.each((t) => {
    if (!accIds.has(t.accountId)) badAcc.push(t.id);
    else if (!catIds.has(t.categoryId)) badCat.push(t.id);
  });
  if (badAcc.length + badCat.length) issues.push({
    id: 'orphan_refs', title: '帳目引用了不存在的帳戶或分類', count: badAcc.length + badCat.length,
    detail: `帳戶遺失 ${badAcc.length} 筆、分類遺失 ${badCat.length} 筆。帳戶遺失者會移到新建立的「已刪除帳戶」，分類遺失者改為「其他」。`,
    fix: async () => {
      if (badAcc.length) {
        const { addAccount } = await import('@/db/repo/accounts');
        const a = await addAccount({ name: '已刪除帳戶', icon: '🗃️', color: '#8E8E93', type: 'other', currency: base, initialBalanceMinor: 0, includeInNetWorth: false, isLiability: false });
        await db.transactions.where('id').anyOf(badAcc).modify({ accountId: a.id });
      }
      if (badCat.length) {
        const txs = await db.transactions.bulkGet(badCat);
        await db.transaction('rw', db.transactions, async () => {
          for (const t of txs) if (t) await db.transactions.update(t.id, { categoryId: t.type === 'income' ? 'inc-other_inc' : 'exp-other_exp' });
        });
      }
      await recomputeBalances(true);
      return '已修復';
    },
  });

  // 孤兒附件
  const atts = await db.attachments.toArray();
  const txIds = new Set(await db.transactions.toCollection().primaryKeys());
  const orphans = atts.filter((a) => !a.transactionId || !txIds.has(a.transactionId));
  if (orphans.length) issues.push({
    id: 'orphan_attachments', title: '沒有對應帳目的照片', count: orphans.length,
    detail: `約佔 ${Math.round(orphans.reduce((s, a) => s + a.blob.size + a.thumb.size, 0) / 1024)} KB`,
    fix: async () => { await db.attachments.bulkDelete(orphans.map((a) => a.id)); return `已刪除 ${orphans.length} 張`; },
  });

  // 永久清除超過 30 天的已刪除資料
  const cutoff = Date.now() - PURGE_DAYS * 86400000;
  const oldTx = await db.transactions.filter((t) => !!t.deletedAt && t.deletedAt < cutoff).primaryKeys();
  const oldTr = await db.transfers.filter((t) => !!t.deletedAt && t.deletedAt < cutoff).primaryKeys();
  const oldTrade = await db.stock_trades.filter((t) => !!t.deletedAt && t.deletedAt < cutoff).primaryKeys();
  const n = oldTx.length + oldTr.length + oldTrade.length;
  if (n) issues.push({
    id: 'purge_deleted', title: `已刪除超過 ${PURGE_DAYS} 天的資料`, count: n,
    detail: '刪除後 30 天內仍可「復原」，之後可永久清除以節省空間。',
    fix: async () => {
      await db.transactions.bulkDelete(oldTx);
      await db.transfers.bulkDelete(oldTr);
      await db.stock_trades.bulkDelete(oldTrade);
      await db.attachments.where('transactionId').anyOf(oldTx as string[]).delete();
      return `已永久清除 ${n} 筆`;
    },
  });

  return issues;
}

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted: (await navigator.storage.persisted?.()) ?? false };
  } catch { return null; }
}

/**
 * IndexedDB 結構（Dexie）。版本 1 即建立全部資料表，後續階段只加功能、不改結構；
 * 若未來需要變更索引，新增 db.version(n).stores(...).upgrade(...)，切勿修改已發布的版本。
 */
import Dexie, { type Table } from 'dexie';
import type {
  Account, Attachment, Budget, CategoryRule, BudgetPeriod, Category, Debt, Dividend, ExchangeRate, Goal,
  Installment, Person, PortfolioSnapshot, PriceCache, PriceHistory, Project, RecurringRule,
  Reminder, SavedFilter, SettingRow, Stock, StockTrade, Tag, Template, Transaction, Transfer, WatchItem, Wish,
} from './types';
import { OUTBOX, syncTracking, type OutboxEntry } from './sync-tracking';

export class ClureDB extends Dexie {
  accounts!: Table<Account, string>;
  categories!: Table<Category, string>;
  transactions!: Table<Transaction, string>;
  transfers!: Table<Transfer, string>;
  attachments!: Table<Attachment, string>;
  templates!: Table<Template, string>;
  budgets!: Table<Budget, string>;
  budget_periods!: Table<BudgetPeriod, string>;
  projects!: Table<Project, string>;
  tags!: Table<Tag, string>;
  saved_filters!: Table<SavedFilter, string>;
  recurring_rules!: Table<RecurringRule, string>;
  installments!: Table<Installment, string>;
  people!: Table<Person, string>;
  debts!: Table<Debt, string>;
  goals!: Table<Goal, string>;
  exchange_rates!: Table<ExchangeRate, [string, string]>;
  stocks!: Table<Stock, string>;
  stock_trades!: Table<StockTrade, string>;
  dividends!: Table<Dividend, string>;
  price_cache!: Table<PriceCache, string>;
  price_history!: Table<PriceHistory, [string, string]>;
  portfolio_snapshots!: Table<PortfolioSnapshot, string>;
  watchlist!: Table<WatchItem, string>;
  reminders!: Table<Reminder, string>;
  settings!: Table<SettingRow, string>;
  meta!: Table<SettingRow, string>;
  wishes!: Table<Wish, string>;
  sync_outbox!: Table<OutboxEntry, string>;
  rules!: Table<CategoryRule, string>;

  constructor(name = 'clure') {
    super(name);
    this.version(1).stores({
      accounts: 'id, type, currency, sort, archived, groupId',
      categories: 'id, kind, parentId, [kind+parentId], sort, archived, system',
      transactions:
        'id, date, ts, type, accountId, categoryId, projectId, *tagIds, ' +
        '[accountId+date], [categoryId+date], [projectId+date], ' +
        'recurringRuleId, installmentId, transferId, stockTradeId, dividendId, deletedAt',
      transfers: 'id, date, fromAccountId, toAccountId, deletedAt',
      attachments: 'id, transactionId',
      templates: 'id, sort',
      budgets: 'id, periodType, categoryId, projectId, active',
      budget_periods: 'id, budgetId, [budgetId+start]',
      projects: 'id, status, start',
      tags: 'id, &name, sort',
      saved_filters: 'id, sort',
      recurring_rules: 'id, nextDue, kind, active',
      installments: 'id, accountId, status',
      people: 'id, &name',
      debts: 'id, personId, transactionId, settled, date',
      goals: 'id, status, deadline',
      exchange_rates: '[base+quote], updatedAt',
      stocks: 'id, &[market+symbol], symbol, market, name',
      stock_trades: 'id, stockId, accountId, date, [stockId+date], type',
      dividends: 'id, stockId, exDate, payDate, accountId',
      price_cache: 'stockId, updatedAt',
      price_history: '[stockId+date], stockId',
      portfolio_snapshots: 'date',
      watchlist: 'id, &stockId, sort',
      reminders: 'id, kind, dueAt, refId, done',
      settings: 'key',
      meta: 'key',
    });
    // v2：心願清單（只新增資料表，既有資料不需轉換）
    this.version(2).stores({
      wishes: 'id, status, decideAt',
    });
    // v3：跨裝置同步的待上傳佇列
    this.version(3).stores({
      [OUTBOX]: 'id, at',
    });
    // v4：自動分類規則；帳目加上電子發票號碼索引（匯入時避免重複）
    this.version(4).stores({
      rules: 'id, priority, categoryId',
      transactions:
        'id, date, ts, type, accountId, categoryId, projectId, *tagIds, ' +
        '[accountId+date], [categoryId+date], [projectId+date], ' +
        'recurringRuleId, installmentId, transferId, stockTradeId, dividendId, deletedAt, invoiceNo',
    });
    this.use(syncTracking);
  }
}

/**
 * 目前使用中的資料庫。登入後切換為該使用者專屬的 `clure-u{userId}`（同一台裝置多人使用互不干擾）。
 * 使用 `export let`：ES 模組為 live binding，切換後所有 `import { db }` 的地方都會拿到新的實例。
 */
export let db = new ClureDB('clure');

export const LEGACY_DB_NAME = 'clure';

export function userDbName(userId: number | string): string {
  return `clure-u${userId}`;
}

/** 切換到指定使用者的資料庫，並標記擁有者 */
export async function openUserDatabase(userId: number | string): Promise<void> {
  const name = userDbName(userId);
  if (db.name !== name) {
    db.close();
    db = new ClureDB(name);
  }
  await db.open();
  const owner = await db.meta.get('ownerUserId');
  if (!owner) await db.meta.put({ key: 'ownerUserId', value: String(userId) });
  else if (String(owner.value) !== String(userId)) throw new Error('本機資料庫擁有者不符');
}

/** 登入前（未啟用帳號系統時）留下的本機資料筆數；0 代表沒有需要歸屬的資料 */
export async function legacyDataCount(): Promise<number> {
  if (!(await Dexie.exists(LEGACY_DB_NAME))) return 0;
  const legacy = new ClureDB(LEGACY_DB_NAME);
  try {
    await legacy.open();
    return (await legacy.transactions.count()) + (await legacy.accounts.count());
  } finally {
    legacy.close();
  }
}

/** 把舊資料庫的所有資料複製到目前使用者的資料庫，成功後刪除舊資料庫 */
export async function adoptLegacyData(): Promise<number> {
  const legacy = new ClureDB(LEGACY_DB_NAME);
  await legacy.open();
  let rows = 0;
  try {
    for (const t of legacy.tables) {
      if (t.name === 'meta' || t.name === 'sync_outbox') continue;
      const all = await t.toArray();
      if (all.length) await db.table(t.name).bulkPut(all);
      rows += all.length;
    }
    // meta 只搬設定類，不覆蓋擁有者標記
    for (const m of await legacy.meta.toArray()) if (m.key !== 'ownerUserId') await db.meta.put(m);
  } finally {
    legacy.close();
  }
  await Dexie.delete(LEGACY_DB_NAME);
  return rows;
}

/** 放棄舊資料（刪除舊資料庫） */
export async function discardLegacyData(): Promise<void> {
  await Dexie.delete(LEGACY_DB_NAME);
}

/** UUID v7：時間排序友善，匯入合併不衝突 */
export function uid(): string {
  const ms = Date.now();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms >>> 24) & 0xff;
  bytes[3] = (ms >>> 16) & 0xff;
  bytes[4] = (ms >>> 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function stamp<T extends object>(row: T): T & { createdAt: number; updatedAt: number } {
  const now = Date.now();
  return { createdAt: now, updatedAt: now, ...row };
}

/**
 * 資料模型型別（對應 docs/DESIGN.md 第 3 節）。
 * 慣例：*Minor = 最小單位整數金額；*Dec = decimal 字串；date = 本地 'YYYY-MM-DD'；ts / *At = epoch ms。
 */

export interface BaseRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
  isSample?: boolean;
}

export type AccountType = 'cash' | 'bank' | 'epay' | 'credit' | 'stored' | 'brokerage' | 'loan' | 'other';

export interface CreditCardInfo {
  limitMinor: number;
  /** 結帳日（1–31，超過月底以月底計） */
  statementDay: number;
  /** 繳款日 */
  dueDay: number;
  autoPayAccountId?: string;
}

export interface BrokerageInfo {
  feeDiscountDec: string;
  minFeeMinor: number;
  oddLotMinFeeMinor: number;
  settlementAccountId?: string;
}

/** 貸款（房貸、車貸…）：用來產生攤還表、記錄每期還款 */
export interface LoanInfo {
  kind: 'mortgage' | 'car' | 'personal' | 'student' | 'other';
  /** 原始貸款本金（帳戶幣別最小單位） */
  principalMinor: number;
  /** 年利率（%） */
  aprDec: string;
  termMonths: number;
  /** 第一期還款日 */
  firstPaymentDate: string;
  /** 預設扣款帳戶 */
  payFromAccountId?: string;
}

export interface Account extends BaseRow {
  name: string;
  icon: string;
  color: string;
  type: AccountType;
  currency: string;
  initialBalanceMinor: number;
  /** 快取餘額：由 repo 層在同一個 DB 交易中維護，健康檢查可重算 */
  balanceMinor: number;
  includeInNetWorth: boolean;
  isLiability: boolean;
  credit?: CreditCardInfo;
  brokerage?: BrokerageInfo;
  loan?: LoanInfo;
  sort: number;
  archived: 0 | 1;
  groupId?: string;
  note?: string;
}

export type CategoryKind = 'expense' | 'income';
export type SystemCategory = 'dividend' | 'interest' | 'stock_fee' | 'adjust' | 'transfer_fee' | 'stock_buy' | 'stock_sell' | 'debt_out' | 'debt_in';

export interface Category extends BaseRow {
  kind: CategoryKind;
  /** '' 代表主分類（IndexedDB 索引不能用 null） */
  parentId: string;
  name: string;
  icon: string;
  color: string;
  sort: number;
  archived: 0 | 1;
  system?: SystemCategory;
}

export type TxType = 'expense' | 'income' | 'adjust' | 'transfer_fee';

export interface Transaction extends BaseRow {
  type: TxType;
  accountId: string;
  categoryId: string;
  /** 原幣金額（正數；adjust 可為負，代表調降餘額） */
  amountMinor: number;
  currency: string;
  /** 原幣 → 帳戶幣別匯率（同幣別時省略） */
  fxRateDec?: string;
  /** 實際影響帳戶的金額（帳戶幣別，正數；adjust 帶正負號） */
  accountAmountMinor: number;
  /** 換算主幣別金額（報表用） */
  baseAmountMinor: number;
  date: string;
  ts: number;
  note: string;
  merchant?: string;
  /** 電子發票號碼（例如 AB12345678），匯入時用來避免重複 */
  invoiceNo?: string;
  tagIds: string[];
  projectId?: string;
  attachmentIds: string[];
  recurringRuleId?: string;
  installmentId?: string;
  installmentNo?: number;
  transferId?: string;
  stockTradeId?: string;
  dividendId?: string;
  split?: { myShareMinor: number; debtIds: string[] };
  excludeFromBudget?: boolean;
  excludeFromStats?: boolean;
}

export interface Transfer extends BaseRow {
  fromAccountId: string;
  toAccountId: string;
  fromAmountMinor: number;
  toAmountMinor: number;
  fxRateDec?: string;
  feeMinor: number;
  feeAccountId?: string;
  feeTransactionId?: string;
  date: string;
  ts: number;
  note: string;
  tagIds: string[];
  projectId?: string;
}

export interface Attachment {
  id: string;
  transactionId: string;
  blob: Blob;
  thumb: Blob;
  mime: string;
  width: number;
  height: number;
  createdAt: number;
}

export interface Template extends BaseRow {
  name: string;
  payload: Partial<Pick<Transaction, 'type' | 'accountId' | 'categoryId' | 'amountMinor' | 'currency' | 'note' | 'tagIds' | 'projectId'>>;
  sort: number;
  useCount: number;
}

export interface Tag extends BaseRow {
  name: string;
  color: string;
  sort: number;
}

export interface Project extends BaseRow {
  note?: string;
  name: string;
  icon: string;
  color: string;
  start: string;
  end?: string;
  currency: string;
  budgetMinor?: number;
  status: 'active' | 'done' | 'archived';
}

export interface Budget extends BaseRow {
  name: string;
  periodType: 'month' | 'week' | 'custom';
  customDays?: number;
  startDate: string;
  amountMinor: number;
  currency: string;
  categoryId: string; // '' = 總預算
  projectId: string; // '' = 不限
  rollover: boolean;
  alertPercents: number[];
  active: 0 | 1;
}

export interface BudgetPeriod {
  id: string;
  budgetId: string;
  start: string;
  end: string;
  limitMinor: number;
  spentMinor: number;
  carryOverMinor: number;
}

export interface SavedFilter extends BaseRow {
  name: string;
  sort: number;
  filter: TxFilter;
}

export interface TxFilter {
  start?: string;
  end?: string;
  types?: TxType[];
  accountIds?: string[];
  categoryIds?: string[];
  projectIds?: string[];
  tagIds?: string[];
  tagMode?: 'any' | 'all';
  minMinor?: number;
  maxMinor?: number;
  keyword?: string;
}

export interface RecurrenceRule {
  freq: 'day' | 'week' | 'month' | 'year';
  interval: number;
  byWeekday?: number[];
  byMonthDay?: number;
  monthEndPolicy?: 'clamp' | 'skip';
  until?: string;
  count?: number;
}

export interface RecurringRule extends BaseRow {
  kind: 'normal' | 'subscription';
  name: string;
  template: Partial<Transaction>;
  rule: RecurrenceRule;
  /** 第一次發生日（規則錨點） */
  startDate: string;
  nextDue: string;
  /** 已產生（或已略過）的期數 */
  doneCount: number;
  /** confirm 模式下等待使用者確認的日期 */
  pendingDates: string[];
  mode: 'auto' | 'confirm';
  remindDaysBefore: number;
  subscription?: { service: string; logo?: string; priceHistory: { date: string; amountMinor: number }[] };
  active: 0 | 1;
}

export interface InstallmentScheduleItem {
  no: number;
  date: string;
  principalMinor: number;
  interestMinor: number;
  feeMinor: number;
  transactionId?: string;
}

export interface Installment extends BaseRow {
  name: string;
  accountId: string;
  categoryId: string;
  principalMinor: number;
  currency: string;
  periods: number;
  aprDec: string;
  feeMinor: number;
  feeMode: 'first' | 'spread';
  firstDate: string;
  schedule: InstallmentScheduleItem[];
  status: 'active' | 'done';
}

export interface Person extends BaseRow {
  name: string;
  avatar?: string;
}

export interface Debt extends BaseRow {
  /** 一次分帳產生的多筆債務共用同一個 groupId */
  groupId?: string;
  personId: string;
  direction: 'they_owe_me' | 'i_owe_them';
  /** 我欠對方、還款時要記入的支出分類 */
  categoryId?: string;
  amountMinor: number;
  currency: string;
  transactionId?: string;
  /** 借出／借入時實際動到帳戶的那筆帳目（有值代表現金已經流動，結清時不計入收支） */
  loanTxId?: string;
  date: string;
  note: string;
  settled: 0 | 1;
  settledAt?: number;
  settleTransferId?: string;
}

export interface Goal extends BaseRow {
  start: string;
  name: string;
  icon: string;
  color: string;
  targetMinor: number;
  currency: string;
  deadline?: string;
  linkedAccountIds: string[];
  manualSavedMinor: number;
  status: 'active' | 'done' | 'archived';
}

export interface ExchangeRate {
  base: string;
  quote: string;
  rateDec: string;
  source: 'api' | 'manual';
  updatedAt: number;
}

export type Market = 'TWSE' | 'TPEX' | 'EMERGING' | 'US' | 'HK';

export interface Stock extends BaseRow {
  market: Market;
  symbol: string;
  name: string;
  currency: string;
  assetType: 'stock' | 'etf' | 'bond_etf';
  industry?: string;
  lotSize: number;
  taxRateDec?: string;
}

export interface StockTrade extends BaseRow {
  stockId: string;
  accountId: string;
  type: 'buy' | 'sell' | 'stock_dividend' | 'split';
  date: string;
  ts: number;
  sharesDec: string;
  priceDec: string;
  feeMinor: number;
  taxMinor: number;
  fxRateDec: string;
  isDCA: boolean;
  costMethodSnapshot?: 'avg' | 'fifo';
  realizedPnlMinor?: number;
  cashAccountId?: string;
  transactionId?: string;
  /** 手續費＋稅另記一筆支出（計入收支統計） */
  feeTransactionId?: string;
  syncToLedger: boolean;
  note: string;
}

export interface Dividend extends BaseRow {
  stockId: string;
  accountId: string;
  kind: 'cash' | 'stock';
  exDate: string;
  payDate: string;
  perShareDec: string;
  sharesHeldDec: string;
  grossMinor: number;
  withholdingTaxMinor: number;
  nhiSupplementMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: string;
  stockTradeId?: string;
  transactionId?: string;
  status: 'announced' | 'paid';
}

export interface PriceCache {
  stockId: string;
  priceDec: string;
  prevCloseDec: string;
  changeDec: string;
  changePctDec: string;
  openDec?: string;
  highDec?: string;
  lowDec?: string;
  volume?: number;
  marketTime: number;
  source: string;
  updatedAt: number;
  isManual: boolean;
}

export interface PriceHistory {
  stockId: string;
  date: string;
  closeDec: string;
}

export interface PortfolioSnapshot {
  date: string;
  netWorthMinor: number;
  assetsMinor: number;
  liabilitiesMinor: number;
  investMarketValueMinor: number;
  investCostMinor: number;
  unrealizedPnlMinor: number;
  realizedPnlCumMinor: number;
  dividendCumMinor: number;
  byAccount: Record<string, number>;
  byStock: Record<string, { sharesDec: string; priceDec: string; mvMinor: number }>;
  filled: 'live' | 'backfill';
}

export interface WatchItem extends BaseRow {
  stockId: string;
  sort: number;
  alerts: { op: '>=' | '<='; priceDec: string; enabled: boolean; lastTriggeredAt?: number }[];
}

export interface Reminder {
  id: string;
  kind: 'daily_log' | 'card_due' | 'budget' | 'subscription' | 'price_alert' | 'backup' | 'sync' | 'insight';
  refId: string;
  dueAt: number;
  done: 0 | 1;
  notifiedAt?: number;
  title: string;
  body: string;
}

/** 自動分類規則（見 domain/rules.ts） */
export interface CategoryRule extends BaseRow {
  keyword: string;
  match: 'contains' | 'equals' | 'regex';
  kind: CategoryKind | 'any';
  categoryId: string;
  tagIds?: string[];
  priority: number;
  enabled: boolean;
  /** 命中次數（統計用） */
  hits: number;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

/** 心願清單：想買的非必需品先放冷靜期，到期再決定買或不買 */
export interface Wish extends BaseRow {
  name: string;
  priceMinor: number;
  currency: string;
  coolDays: number;
  addedOn: string;
  /** 冷靜期結束日 */
  decideAt: string;
  status: 'waiting' | 'bought' | 'abandoned';
  decidedAt?: number;
  transactionId?: string;
  categoryId?: string;
  note?: string;
  url?: string;
}

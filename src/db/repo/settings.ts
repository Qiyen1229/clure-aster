/**
 * 設定（key/value，存在 IndexedDB settings 表）。預設值集中在此，型別安全取用。
 */
import { db } from '../schema';
import type { DecimalsMode } from '@/domain/money';

export type ThemeMode = 'system' | 'light' | 'dark';
export type AccentKey = 'cyan' | 'blue' | 'indigo' | 'purple' | 'pink' | 'orange' | 'green' | 'gold';

export type WidgetKey = 'today' | 'budget' | 'networth' | 'invest' | 'bills' | 'debts' | 'goals' | 'wishlist';
export const ALL_WIDGETS: { key: WidgetKey; label: string }[] = [
  { key: 'today', label: '今日／本月花費' },
  { key: 'budget', label: '今日可用（預算）' },
  { key: 'networth', label: '淨資產' },
  { key: 'invest', label: '持股損益' },
  { key: 'bills', label: '近期帳單與訂閱' },
  { key: 'debts', label: '分帳債務' },
  { key: 'goals', label: '存錢目標' },
  { key: 'wishlist', label: '心願清單（冷靜期）' },
];

export interface QuoteSettings {
  /** 代理網址：NAS Docker 預設同源 /proxy；Cloudflare Worker 則填 https://xxx.workers.dev */
  proxyUrl: string;
  proxyToken: string;
  refreshSec: number;
  twOrder: string[];
  usOrder: string[];
  keys: { finnhub: string; twelvedata: string; alphavantage: string; finmind: string };
}

export interface InvestSettings {
  costMethod: 'avg' | 'fifo';
  syncToLedger: boolean;
  feeRateDec: string;
  discountDec: string;
  minFee: number;
  oddLotMinFee: number;
  taxStockDec: string;
  taxEtfDec: string;
  taxBondEtfDec: string;
  defaultBrokerageId: string;
}

export interface LockSettings {
  enabled: boolean;
  pinHash: string;
  salt: string;
  iterations: number;
  webauthn: { credId: string; publicKey: string; alg: number } | null;
  autoLockSec: number;
}

export interface NotifySettings {
  enabled: boolean;
  daily: boolean;
  dailyTime: string;
  cardDue: boolean;
  cardDueDays: number;
  budget: boolean;
  subscription: boolean;
  priceAlert: boolean;
  backup: boolean;
  backupDays: number;
}

export interface Settings {
  onboarded: boolean;
  locale: 'zh-TW' | 'en';
  baseCurrency: string;
  theme: ThemeMode;
  accent: AccentKey;
  /** 'red'：紅漲綠跌（台股習慣，收入／獲利為紅）；'green'：綠漲紅跌 */
  upColor: 'red' | 'green';
  monthStartDay: number;
  weekStart: 0 | 1;
  decimals: DecimalsMode;
  thousands: boolean;
  hideAmounts: boolean;
  blurOnHide: boolean;
  continuousAdd: boolean;
  lastAccountId: string;
  calendarCollapsed: boolean;
  ledgerUnit: 'day' | 'week' | 'month' | 'year';
  homeWidgets: WidgetKey[];
  quote: QuoteSettings;
  invest: InvestSettings;
  lock: LockSettings;
  notify: NotifySettings;
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  locale: 'zh-TW',
  baseCurrency: 'TWD',
  theme: 'system',
  accent: 'cyan',
  upColor: 'red',
  monthStartDay: 1,
  weekStart: 0,
  decimals: 'auto',
  thousands: true,
  hideAmounts: false,
  blurOnHide: true,
  continuousAdd: false,
  lastAccountId: '',
  calendarCollapsed: false,
  ledgerUnit: 'month',
  homeWidgets: ['today', 'budget', 'networth', 'invest', 'bills'],
  quote: {
    proxyUrl: '/proxy',
    proxyToken: '',
    refreshSec: 60,
    twOrder: ['twse-mis', 'twse-openapi', 'finmind', 'yahoo'],
    usOrder: ['yahoo', 'finnhub', 'twelvedata', 'alphavantage'],
    keys: { finnhub: '', twelvedata: '', alphavantage: '', finmind: '' },
  },
  invest: {
    costMethod: 'avg', syncToLedger: true, feeRateDec: '0.001425', discountDec: '1', minFee: 20, oddLotMinFee: 1,
    taxStockDec: '0.003', taxEtfDec: '0.001', taxBondEtfDec: '0', defaultBrokerageId: '',
  },
  lock: { enabled: false, pinHash: '', salt: '', iterations: 210000, webauthn: null, autoLockSec: 60 },
  notify: {
    enabled: false, daily: true, dailyTime: '21:00', cardDue: true, cardDueDays: 3, budget: true, subscription: true,
    priceAlert: true, backup: true, backupDays: 14,
  },
};

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  const row = await db.settings.get(key);
  return (row?.value as Settings[K]) ?? DEFAULT_SETTINGS[key];
}

export async function loadSettings(): Promise<Settings> {
  const rows = await db.settings.toArray();
  const s = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const r of rows) {
    const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[r.key];
    // 物件型設定與預設值合併，新版本新增的欄位才有預設
    s[r.key] = def && typeof def === 'object' && !Array.isArray(def) && r.value && typeof r.value === 'object' ? { ...def, ...(r.value as object) } : r.value;
  }
  return s as unknown as Settings;
}

export async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await db.settings.put({ key, value });
}

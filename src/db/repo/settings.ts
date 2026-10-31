/**
 * 設定（key/value，存在 IndexedDB settings 表）。預設值集中在此，型別安全取用。
 */
import { db } from '../schema';
import type { DecimalsMode } from '@/domain/money';
import type { ImportProfile } from '@/services/importer';

export type ThemeMode = 'system' | 'light' | 'dark';
/** 文字大小：'system' 跟隨 iPhone「文字大小」設定，數字為根字級（px） */
export type FontSizePref = 'system' | number;
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
  /** 每週摘要（週一早上：上週花了多少、和前一週比） */
  weekly: boolean;
  /** 每月摘要（每月 1 日早上：上個月的收支、分類變化） */
  monthly: boolean;
  /** 背景推播（Web Push，經自架伺服器；App 關閉時也會提醒） */
  push: boolean;
}

export interface Settings {
  onboarded: boolean;
  locale: 'zh-TW' | 'en';
  baseCurrency: string;
  theme: ThemeMode;
  /** 只屬於這台裝置（不同步）：手機與電腦常需要不同大小 */
  fontSize: FontSizePref;
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
  /** 資金流向圖裡算「必要支出」的主分類 id；null＝用預設 */
  sankeyEssential: string[] | null;
  ledgerUnit: 'day' | 'week' | 'month' | 'year';
  homeWidgets: WidgetKey[];
  /** 首頁的對話框（記帳、查帳、問 AI 共用一個輸入框） */
  homeAiChat: boolean;
  quote: QuoteSettings;
  invest: InvestSettings;
  lock: LockSettings;
  notify: NotifySettings;
  /** CSV／對帳單匯入的欄位對應格式 */
  importProfiles: ImportProfile[];
  /** 財務自由試算的假設 */
  fire: FireSettings;
  /** 稅務彙總：綜合所得淨額（不含股利，元）等 */
  tax: { netIncome: number };
  /** 電子發票：手機條碼載具與記帳方式 */
  einvoice: EinvoiceSettings;
  /** 自動記帳收件匣（iPhone 捷徑：Apple Pay、簡訊、Siri） */
  inbox: InboxSettings;
  /**
   * AI：enabled＝規則解析不了一句話時，才把那句話與分類／帳戶名稱送到伺服器設定的 AI 供應商；
   * allowData＝另外允許 AI 看「去識別化的收支統計」（問答、預算建議、洞察、專案／帳戶解說）；
   * auto＝首頁自動產生上週重點（每週最多用 1 點額度）。三個都預設關閉。
   */
  ai: { enabled: boolean; allowData: boolean; auto: boolean };
  /**
   * 智慧提醒（平常全部在本機用規則計算；只有規則判斷不了的新支出，才在 ai.enabled 開啟時請 AI 查市價，且不計額度）：
   * anomaly＝異常與訂閱偵測；budgetWarn＝預算預警；dismissed＝使用者按「略過」的項目 id（隨帳號同步、最多 200 筆）
   */
  insights: { anomaly: boolean; budgetWarn: boolean; dismissed: string[]; /** 規則判斷不了的新支出，請 AI 查市價（需先開啟 ai.enabled；不計額度） */ aiPrice: boolean };
  /** 已看過哪一版的「新功能介紹」（隨帳號同步，換裝置不會再跳一次） */
  seenWhatsNew: string;
}

export interface InboxSettings {
  /** 金額看得懂的項目開啟 App 時直接記帳（否則全部放在收件匣等確認） */
  autoBook: boolean;
  /** 判斷不出帳戶時記到這個帳戶 */
  defaultAccountId: string;
  /** Apple Pay 卡片名稱 → 帳戶（確認記帳時自動學習） */
  cardMap: Record<string, string>;
}

export interface EinvoiceSettings {
  /** 手機條碼（/ 開頭 8 碼） */
  cardNo: string;
  /** 手機條碼驗證碼（用來向財政部查詢；啟用端對端加密時同步內容會加密） */
  verifyCode: string;
  /** 無法依規則或過去記帳判斷帳戶時，記到這個帳戶 */
  defaultAccountId: string;
  /** 開啟 App 時自動抓取新發票並記帳（伺服器需設定財政部 AppID） */
  autoSync: boolean;
}

export interface FireSettings {
  birthYear: number;
  retireAge: number;
  endAge: number;
  returnPct: number;
  volPct: number;
  inflationPct: number;
  swrPct: number;
  /** 0 = 依近 12 個月記帳自動估算 */
  annualExpense: number;
  annualSaving: number;
  /** 起始資產；0 = 使用目前淨資產（有房貸等不用於退休的資產負債時可改填可投資資產） */
  startAssets: number;
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  locale: 'zh-TW',
  baseCurrency: 'TWD',
  theme: 'system',
  fontSize: 'system',
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
  sankeyEssential: null,
  calendarCollapsed: true, // 首頁預設只顯示本週（可展開整月）；已經選過的人維持自己的選擇
  ledgerUnit: 'month',
  homeWidgets: [], // 3.6.1 起首頁預設不放小工具（淨資產、投資、帳單在「帳戶」頁；設定 → 首頁小工具可加回）
  homeAiChat: true,
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
    priceAlert: true, backup: true, backupDays: 14, weekly: true, monthly: true, push: false,
  },
  importProfiles: [],
  fire: { birthYear: 1995, retireAge: 55, endAge: 90, returnPct: 6, volPct: 15, inflationPct: 2, swrPct: 4, annualExpense: 0, annualSaving: 0, startAssets: 0 },
  tax: { netIncome: 0 },
  einvoice: { cardNo: '', verifyCode: '', defaultAccountId: '', autoSync: true },
  inbox: { autoBook: false, defaultAccountId: '', cardMap: {} },
  ai: { enabled: false, allowData: false, auto: false },
  insights: { anomaly: true, budgetWarn: true, dismissed: [], aiPrice: true },
  seenWhatsNew: '',
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
  // 3.6.1：首頁改成簡潔版，舊的預設小工具組合（沒有自己調整過）不再預設顯示；調整過的維持原樣
  if (JSON.stringify(s.homeWidgets) === JSON.stringify(LEGACY_HOME_WIDGETS)) s.homeWidgets = [];
  return s as unknown as Settings;
}

const LEGACY_HOME_WIDGETS = ['today', 'budget', 'networth', 'invest', 'bills'];

export async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await db.settings.put({ key, value });
}

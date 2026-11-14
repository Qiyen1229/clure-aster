/**
 * 自動記帳收件匣（App 端）。
 *
 * 流程：iPhone 捷徑（Apple Pay 交易、銀行簡訊、Siri 一句話）→ POST /api/hook/inbox（捷徑專用權杖）
 * → 伺服器暫存 → App 開啟時取回、解析成帳目草稿 → 使用者確認（或開啟「自動入帳」）→ 記帳並從伺服器刪除。
 *
 * - 確認時先向伺服器「認領」（ack），只有真的刪到的項目才記帳：兩台裝置同時處理也不會重複
 * - 帳戶：學到的卡片對應 → 文字裡的帳戶名稱 → 規則／商家記憶 → 收件匣預設帳戶 → 上次使用的帳戶
 * - 暫存在伺服器上的內容沒有端對端加密（捷徑沒有你的加密密碼）；處理後立即刪除，30 天未處理自動清除
 */
import { api } from './api';
import { useInboxCount } from './inboxCount';
import { extractDate, findAccounts, findAmounts, parseEntries, shortDate, toHalfWidth, type DraftEntry } from '@/domain/nlp';
import { findDuplicate, type DupCandidate } from '@/domain/dedupe';
import { formatMoney, toMinor } from '@/domain/money';
import { addDays, toDateKey, todayKey } from '@/domain/period';
import { db } from '@/db/schema';
import { useSettings } from '@/stores/settings';
import { useUI } from '@/stores/ui';
import { AUTH_ENABLED, useAuth } from '@/stores/auth';
import { bookDrafts, fallbackAccount, parseContext, resolveDraft, type ResolvedDraft } from './quickentry';

export interface InboxRaw {
  id: number;
  source: 'auto' | 'voice' | 'applepay' | 'notify' | 'sms' | 'siri' | 'clipboard' | 'share' | 'quick' | 'email' | 'other';
  text: string;
  amount: string;
  merchant: string;
  card: string;
  occurred: string;
  created_at: string;
}

/** 這則可能和已有的帳目、或收件匣裡的另一則是同一次消費 */
export interface InboxDup {
  /** strong：同一天且商家相近或同帳戶；weak：只有金額相同、日期相差 1 天內 */
  level: 'strong' | 'weak';
  /** ledger：已經記在帳本裡；inbox：收件匣裡另一則（例如 Apple Pay 與簡訊通知同一筆付款） */
  from: 'ledger' | 'inbox';
  txId?: string;
  inboxId?: number;
  /** 顯示用：「今天 全聯 $120」「Apple Pay 那筆」 */
  label: string;
  /** 不同來源、15 分鐘內、同一天：幾乎確定是同一筆付款，自動入帳時直接合併 */
  certain?: boolean;
}

export interface InboxEntry {
  item: InboxRaw;
  /** 解析出的帳目（Siri 一句話可能有多筆）；空陣列代表看不懂金額，需要手動記 */
  drafts: ResolvedDraft[];
  dup?: InboxDup;
  /** 來源不夠可信（例如 LINE 聊天訊息裡剛好有金額）：只留在收件匣等你確認，絕不自動入帳 */
  review?: string;
}

/** LINE 裡視為「官方帳號」的發送者：只有這些名稱出現在訊息裡、且像交易通知，才當作消費通知 */
export const LINE_OFFICIAL_SENDERS = [
  'LINE Pay', 'LINE Bank', '街口', '悠遊付', '悠遊卡', '一卡通', 'iPASS', 'icash', '全支付', '歐付寶',
  '國泰世華', '國泰', '中國信託', '中信', '玉山', '台新', 'Richart', '富邦', '永豐', '聯邦', '兆豐', '第一銀行', '華南',
  '合作金庫', '合庫', '彰化銀行', '彰銀', '凱基', '元大', '新光', '星展', '樂天', '渣打', '滙豐', '匯豐', '王道', '陽信', '遠東商銀', '郵局', '台灣Pay', '台灣 Pay',
];
const TXN_WORDS = /消費|刷卡|扣款|付款成功|支付成功|交易成功|交易通知|授權|繳費成功|入帳|轉帳|退款|退刷|代扣/;
/** 官方通知通常有【標題】或稱呼「您／貴客」；朋友聊天通常沒有 */
const OFFICIAL_STYLE = /[【[][^】\]]{1,20}[】\]]|您|貴/;

/** 這則通知是不是來自 LINE 聊天（而不是 LINE Pay、LINE Bank 這類支付 App） */
export function isLineChat(card: string): boolean {
  const app = card.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  return /^line$/i.test(app) || (/\bLINE\b/i.test(app) && !/pay|bank|錢包|購物/i.test(app));
}

/** LINE 訊息是否為重點官方帳號的交易通知（發送者名稱＋交易字眼＋官方口吻，三者缺一不可） */
export function isTrustedLineNotice(text: string): boolean {
  const t = text.normalize('NFKC');
  const lower = t.toLowerCase();
  return LINE_OFFICIAL_SENDERS.some((n) => lower.includes(n.normalize('NFKC').toLowerCase())) && TXN_WORDS.test(t) && OFFICIAL_STYLE.test(t);
}

export type NoticeVerdict = { trust: 'ok' } | { trust: 'review'; reason: string } | { trust: 'drop' };

/** 白名單比對：發送者名稱出現在商家或訊息裡就算命中（不分大小寫、全半形正規化） */
export function matchesWhitelist(it: Pick<InboxRaw, 'text' | 'merchant'>, whitelist: string[]): boolean {
  if (!whitelist.length) return false;
  const hay = `${it.merchant ?? ''}\n${it.text ?? ''}`.normalize('NFKC').toLowerCase();
  return whitelist.some((w) => {
    const n = w.trim().normalize('NFKC').toLowerCase();
    return n.length > 0 && hay.includes(n);
  });
}

/**
 * 通知來源把關：銀行／支付 App 的通知照舊；LINE 聊天只放行重點官方帳號與使用者自訂的白名單。
 * 不是官方的 LINE 訊息：看不出金額的直接丟掉（聊天雜訊）；剛好有金額的留在收件匣等確認，不自動入帳。
 */
export function judgeNotice(it: Pick<InboxRaw, 'source' | 'card' | 'text' | 'merchant'>, hasDrafts: boolean, whitelist: string[] = []): NoticeVerdict {
  if (matchesWhitelist(it, whitelist)) return { trust: 'ok' };
  if (it.source !== 'notify' || !isLineChat(it.card ?? '')) return { trust: 'ok' };
  if (isTrustedLineNotice(`${it.merchant ?? ''}\n${it.text ?? ''}`)) return { trust: 'ok' };
  return hasDrafts ? { trust: 'review', reason: '這是 LINE 聊天訊息（不是官方帳號的消費通知），確認真的是消費再記' } : { trust: 'drop' };
}

export interface InboxToken { id: number; name: string; hint: string; created_at: string; last_used_at: string | null; use_count?: number }

export const SOURCE_LABEL: Record<InboxRaw['source'], { icon: string; label: string }> = {
  auto: { icon: '⚡', label: '自動' },
  voice: { icon: '🎙', label: '隨手記' },
  notify: { icon: '🔔', label: '通知' },
  applepay: { icon: '💳', label: 'Apple Pay' },
  sms: { icon: '💬', label: '簡訊' },
  siri: { icon: '🎙', label: 'Siri' },
  clipboard: { icon: '📋', label: '剪貼簿' },
  share: { icon: '📤', label: '分享' },
  quick: { icon: '⚡', label: '快速記帳' },
  email: { icon: '✉️', label: 'Email' },
  other: { icon: '📥', label: '捷徑' },
};

/** 首頁提示用的待確認數 */
export { useInboxCount };

export const hookUrl = () => `${location.origin}/api/hook/inbox`;

/** 預先做好、簽署過的捷徑（scripts/make-shortcuts.py 產生 public/shortcuts/aster-<key>.shortcut）；name＝匯入後的捷徑名稱 */
export const SHORTCUTS = [
  { key: 'auto', name: 'Aster 自動記帳', icon: '⚡', title: '銀行 App／LINE Pay／街口／Apple Pay 自動記帳', automation: '通知與錢包', icloud: '78007b1d408246d3b5957a4174d4674c', hint: '最推薦：刷實體卡、網購、LINE Pay、街口、Apple Pay 跳通知就自動記（已內建 52 家銀行與支付 App）' },
  { key: 'voice', name: 'Aster 隨手記', icon: '🎙', title: '對 Siri 說一句話記帳 ＋ 分享選單記帳', automation: null, icloud: 'c9f38f3363294443918b040e21156d46', hint: '「嘿 Siri，Aster 隨手記」說出花費，或在任何 App 按分享直接把文字送去記帳' },
] as const;

type ShortcutDef = (typeof SHORTCUTS)[number];
export const shortcutFileUrl = (s: ShortcutDef) => `/shortcuts/aster-${s.key}.shortcut`;

/**
 * 加入捷徑：直接開 iCloud 分享連結（https://www.icloud.com/shortcuts/<id>），iOS 會用通用連結交給「捷徑」App，跳出「加入捷徑」。
 * 六個捷徑都是通用範本（不含你的連結碼或權杖；連結碼是匯入時才貼上的），所以全部使用者共用同一組 iCloud 連結。
 * 不要用 `shortcuts://import-shortcut?url=<iCloud 連結>`：那個網址要的是「.shortcut 檔案網址」，給 iCloud 網頁連結會顯示「檔案的格式不正確」；
 * 給自架的檔案網址則是「提供的捷徑 URL 無效」。檔案版（`shortcutFileUrl`）只留作備用下載。
 * 捷徑內容更新時：用 scripts/make-shortcuts.py 重做 → 匯入 Mac「捷徑」App → 分享 →「拷貝 iCloud 連結」→ 換掉這裡的 `icloud` 識別碼。
 */
export const shortcutIcloudUrl = (s: ShortcutDef) => `https://www.icloud.com/shortcuts/${s.icloud}`;

export function openShortcutImport(s: ShortcutDef): void {
  location.href = shortcutIcloudUrl(s);
}

/** 連結碼＝網址＋?t=權杖：捷徑匯入時只要貼上這一串。存在這台裝置（依使用者區分），之後加其他捷徑可重用 */
export const linkCode = (token: string) => `${hookUrl()}?t=${token}`;
const linkKey = () => `clure.inbox.link.${useAuth.getState().user?.id ?? 0}`;

export function savedLink(): { id: number; code: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(linkKey()) ?? 'null') as { id: number; code: string } | null;
    return v && typeof v.code === 'string' ? v : null;
  } catch { return null; }
}

export function forgetLink() {
  try { localStorage.removeItem(linkKey()); } catch { /* 私密瀏覽 */ }
}

/**
 * 這台裝置的名稱（已連結的裝置清單用）。網頁拿不到 iPhone 的確切型號（iOS 不提供），所以用螢幕尺寸推算：
 * 「iPhone 6.9 吋」「iPad」「Android（SM-S918B）」「Mac」。
 */
export function deviceLabel(nav: Pick<Navigator, 'userAgent'> = navigator, scr: { width: number; height: number } = screen): string {
  const ua = nav.userAgent;
  if (/iPhone/.test(ua)) {
    const w = Math.min(scr.width, scr.height), h = Math.max(scr.width, scr.height);
    const inch: Record<string, string> = { '440x956': '6.9', '430x932': '6.7', '428x926': '6.7', '414x896': '6.1／6.5', '412x915': '6.7', '402x874': '6.3', '393x852': '6.1', '390x844': '6.1', '375x812': '5.4／5.8', '375x667': '4.7', '320x568': '4' };
    const s = inch[`${w}x${h}`];
    return s ? `iPhone ${s} 吋` : 'iPhone';
  }
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)) return 'iPad';
  const android = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build|\)|;)/);
  if (android) return `Android（${android[1].trim()}）`;
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return '這台裝置';
}

/** 取得這台裝置的連結碼；沒有就建立一組以裝置名稱命名的權杖 */
export async function ensureLink(): Promise<{ id: number; code: string; created?: InboxToken }> {
  const saved = savedLink();
  if (saved) return saved;
  const r = await createToken(deviceLabel());
  const link = { id: r.item.id, code: linkCode(r.token) };
  try { localStorage.setItem(linkKey(), JSON.stringify(link)); } catch { /* 私密瀏覽：這次仍可用 */ }
  return { ...link, created: r.item };
}

export const listTokens = () => api<InboxToken[]>('/inbox/tokens');
export const createToken = (name: string) => api<{ token: string; item: InboxToken }>('/inbox/tokens', { method: 'POST', body: { name } });
export const revokeToken = (id: number) => api(`/inbox/tokens/${id}`, { method: 'DELETE' });

export async function fetchInbox(): Promise<InboxRaw[]> {
  const list = await api<InboxRaw[]>('/inbox/items');
  useInboxCount.getState().set(list.length);
  return list;
}

/** 從伺服器移除；回傳實際移除的 id（別台裝置已處理的不會出現） */
export async function ackInbox(ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const r = await api<{ ids: number[] }>('/inbox/items/ack', { method: 'POST', body: { ids } });
  const s = useInboxCount.getState();
  s.set(Math.max(0, s.n - r.ids.length));
  return r.ids;
}

/** 通知／簡訊／Email 裡的商店名稱：「商店:全聯」「特店名稱：Uber」「於 全家 消費」「在 7-ELEVEN 付款」 */
export function noticeMerchant(text: string): string {
  const s = toHalfWidth(text);
  const prefixMatch = s.match(/(?:商店|特店|商家|店家|消費地點|交易商店|交易店家|商戶|門市)(?:名稱)?\s*[:：]\s*([^\n,，。;；)）]+)/);
  if (prefixMatch) {
    let m = prefixMatch[1].trim();
    m = m.replace(/\s*(?:NT\$|NTD|TWD|\$|金額|消費|\d{1,2}\/\d{1,2}).*$/i, '').trim();
    if (m) return m;
  }
  const m = s.match(/(?:商店|特店|商家|店家|消費地點|交易商店|交易店家|商戶|門市)\s*[:：]?\s*([^\s\n,，。;；)）]+)/)
    ?? s.match(/(?:於|在)\s*([^\n,，。;；()（）]{2,25}?)\s*(?:消費|刷卡|交易|付款|扣款|支付|成功)/);
  return m?.[1]?.trim() ?? '';
}

/** 捷徑傳來的交易時間：2026/10/28 12:30、2026年10月28日、ISO、英文日期；看不懂就用收到的時間 */
export function itemDate(it: Pick<InboxRaw, 'occurred' | 'created_at'>, today = todayKey()): string {
  if (it.occurred) {
    const d = extractDate(it.occurred, today).date;
    if (d) return d;
    const t = new Date(it.occurred);
    if (!Number.isNaN(t.getTime())) return toDateKey(t);
  }
  // 伺服器時間是 UTC（沒有時區字尾）
  const c = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(it.created_at) ? it.created_at : `${it.created_at}Z`);
  return Number.isNaN(c.getTime()) ? today : toDateKey(c);
}

type Ctx = Awaited<ReturnType<typeof parseContext>>;

/** 卡片名稱 → 帳戶：學過的對應優先，其次是名稱比對（「玉山 Pi 卡」→ 玉山銀行） */
export function cardAccount(card: string, ctx: Ctx, cardMap: Record<string, string>): string | undefined {
  if (!card) return undefined;
  const learned = cardMap[card];
  if (learned && ctx.accounts.some((a) => a.id === learned)) return learned;
  return findAccounts(card, ctx.accounts)[0]?.id;
}

/** 把一則收件匣項目解析成帳目草稿 */
export async function draftsFromItem(it: InboxRaw, ctx: Ctx, fallback: string): Promise<ResolvedDraft[]> {
  const { cardMap, defaultAccountId } = useSettings.getState().inbox;
  const date = itemDate(it, ctx.today);
  const base = defaultAccountId && ctx.accounts.some((a) => a.id === defaultAccountId) ? defaultAccountId : fallback;
  const byCard = cardAccount(it.card, ctx, cardMap);
  let drafts: DraftEntry[];
  if (it.amount) {
    // Apple Pay：金額、商家、卡片都是分開的欄位
    const hit = findAmounts(it.amount)[0] ?? findAmounts(`${it.amount}元`)[0];
    if (!hit) return [];
    const text = [it.merchant, it.text].filter(Boolean).join(' ');
    const refund = /退款|退貨|refund/i.test(`${it.text} ${it.amount}`) || /^\s*[-−]/.test(it.amount);
    drafts = [{
      kind: refund ? 'income' : 'expense', amount: hit.value, currency: hit.currency, date, dateGiven: true,
      accountId: undefined, note: it.merchant || it.text, raw: text,
    }];
  } else {
    drafts = parseEntries(it.text, { ...ctx, today: date });
    if (!drafts.length) return [];
    // 通知／簡訊：多個金額時只取一筆（其餘多半是額度、餘額），備註換成商店名稱
    if (it.source === 'notify' || it.source === 'sms' || it.source === 'email') {
      const merchant = it.merchant || noticeMerchant(it.text);
      drafts = [{ ...drafts[0], note: merchant || drafts[0].note.slice(0, 40), kind: /退款|退貨|退刷/.test(it.text) ? 'income' : 'expense' }];
    }
  }
  const out: ResolvedDraft[] = [];
  for (const d of drafts) {
    let targetAcc: string | undefined;
    if (it.source === 'notify') {
      // 若文字中提到非 App 本身的帳戶（例如 LINE Pay 通知提及「國泰世華」），優先以該銀行卡入帳
      const textAccs = findAccounts(it.text, ctx.accounts);
      const bankAcc = textAccs.find((a) => {
        const accObj = ctx.accounts.find((acc) => acc.id === a.id);
        return accObj && accObj.name.toLowerCase() !== (it.card || '').toLowerCase();
      });
      targetAcc = bankAcc?.id ?? byCard ?? d.accountId;
    } else {
      targetAcc = byCard ?? d.accountId;
    }
    const r = await resolveDraft({ ...d, accountId: targetAcc }, base);
    out.push(targetAcc ? { ...r, accountId: targetAcc, accountSource: 'text' } : r);
  }
  return out;
}

const createdMs = (it: InboxRaw) => {
  const t = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(it.created_at) ? it.created_at : `${it.created_at}Z`).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/**
 * 標出可能重複的項目：先和收件匣裡較早的一則比（Apple Pay 與銀行簡訊常常通知同一筆付款），
 * 再和帳本裡前後一天的帳目比（電子發票載具、手動記帳）。只標記，不刪除。
 * 一則只標一個最像的；只處理「一則一筆」的項目（Siri 多筆的不比對）。
 */
export async function markDuplicates(entries: InboxEntry[], today = todayKey()): Promise<void> {
  const single = entries.filter((e) => e.drafts.length === 1 && e.drafts[0].kind !== 'transfer');
  if (!single.length) return;
  const accounts = new Map((await db.accounts.toArray()).map((a) => [a.id, a]));
  const probeOf = (e: InboxEntry) => {
    const d = e.drafts[0];
    const cur = d.currency ?? accounts.get(d.accountId)?.currency ?? 'TWD';
    return { cur, p: { date: d.date, amountMinor: toMinor(d.amount, cur), currency: cur, accountId: d.accountId, text: `${e.item.merchant} ${d.note}` } };
  };
  const ordered = [...single].sort((a, b) => a.item.id - b.item.id);
  const dates = ordered.map((e) => e.drafts[0].date).sort();
  const rows = await db.transactions.where('date').between(addDays(dates[0], -1), addDays(dates[dates.length - 1], 1), true, true)
    .filter((t) => !t.deletedAt && !t.categoryId.startsWith('sys-') && (t.type === 'expense' || t.type === 'income')).toArray();
  const ledger = new Map(rows.map((t) => [t.id, t]));
  const ledgerCands = (kind: string): DupCandidate[] => rows.filter((t) => t.type === kind)
    .map((t) => ({ id: t.id, date: t.date, amountMinor: t.amountMinor, currency: t.currency, accountId: t.accountId, text: `${t.merchant ?? ''} ${t.note}` }));
  const exp = ledgerCands('expense');
  const inc = ledgerCands('income');

  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    const { cur, p } = probeOf(e);
    // 收件匣內：較早的、來源不同的另一則
    const earlier = ordered.slice(0, i).filter((o) => o.drafts[0].kind === e.drafts[0].kind).map((o) => {
      const q = probeOf(o);
      return { id: String(o.item.id), ...q.p };
    });
    const inboxHit = findDuplicate(p, earlier);
    if (inboxHit) {
      const other = ordered.find((o) => String(o.item.id) === inboxHit.id)!;
      const sameDay = other.drafts[0].date === e.drafts[0].date;
      const close = Math.abs(createdMs(e.item) - createdMs(other.item)) <= 15 * 60_000;
      e.dup = {
        level: inboxHit.level === 'strong' || (sameDay && close) ? 'strong' : 'weak', from: 'inbox', inboxId: other.item.id,
        label: `${SOURCE_LABEL[other.item.source]?.label ?? '另一則'} 那筆`, certain: other.item.source !== e.item.source && sameDay && close,
      };
      continue;
    }
    const hit = findDuplicate(p, e.drafts[0].kind === 'income' ? inc : exp);
    if (hit) {
      const t = ledger.get(hit.id)!;
      e.dup = { level: hit.level, from: 'ledger', txId: t.id, label: `${shortDate(t.date, today)} ${t.merchant || t.note || '已記的帳'} ${formatMoney(t.amountMinor, cur)}` };
    }
  }
}

export async function loadInbox(): Promise<InboxEntry[]> {
  const [items, ctx, fallback] = await Promise.all([fetchInbox(), parseContext(), fallbackAccount()]);
  const out: InboxEntry[] = [];
  const dropIds: number[] = [];
  for (const item of items) {
    const drafts = await draftsFromItem(item, ctx, fallback).catch(() => []);
    const v = judgeNotice(item, drafts.length > 0, useSettings.getState().inbox.whitelist ?? []);
    if (v.trust === 'drop') { dropIds.push(item.id); continue; }
    out.push({ item, drafts, ...(v.trust === 'review' ? { review: v.reason } : {}) });
  }
  // 非官方的 LINE 聊天雜訊：直接從收件匣清掉，不留紀錄
  if (dropIds.length) await ackInbox(dropIds).catch(() => []);
  await markDuplicates(out, ctx.today).catch(() => undefined);
  return out;
}

/**
 * 給操作助手預覽用的收件匣：和 loadInbox 一樣解析、標重複，但「唯讀」——
 * 不認領刪除任何項目（包括 LINE 雜訊），因為預覽不該改動伺服器狀態；真的執行時才走 bookInboxEntries／ackInbox。
 * 短時間內重複呼叫（同一份計畫反覆預覽）用快取，避免一直打伺服器。
 */
let roCache: { at: number; entries: InboxEntry[] } | null = null;
export async function loadInboxReadOnly(): Promise<InboxEntry[]> {
  if (!AUTH_ENABLED) return [];
  if (roCache && Date.now() - roCache.at < 30_000) return roCache.entries;
  const [items, ctx, fallback] = await Promise.all([fetchInbox(), parseContext(), fallbackAccount()]);
  const out: InboxEntry[] = [];
  for (const item of items) {
    const drafts = await draftsFromItem(item, ctx, fallback).catch(() => []);
    const v = judgeNotice(item, drafts.length > 0, useSettings.getState().inbox.whitelist ?? []);
    if (v.trust === 'drop') continue;
    out.push({ item, drafts, ...(v.trust === 'review' ? { review: v.reason } : {}) });
  }
  await markDuplicates(out, ctx.today).catch(() => undefined);
  roCache = { at: Date.now(), entries: out };
  return out;
}
/** 執行過收件匣操作後清掉唯讀快取，下次預覽重新抓 */
export function invalidateInboxReadOnly(): void { roCache = null; }

/** 「合併」：這則其實是已經記過的那筆，只補上缺少的商家，然後從收件匣移除（不新增帳目） */
export async function mergeDuplicate(e: InboxEntry): Promise<boolean> {
  const removed = await ackInbox([e.item.id]);
  if (!removed.length) return false;
  if (e.dup?.from === 'ledger' && e.dup.txId) {
    const t = await db.transactions.get(e.dup.txId);
    const merchant = e.item.merchant || e.drafts[0]?.note;
    if (t && !t.deletedAt && !t.merchant && merchant) await db.transactions.update(t.id, { merchant: merchant.slice(0, 60), updatedAt: Date.now() });
    learnCard(e.item.card, t?.accountId);
  }
  return true;
}

/** 記住「這張卡 → 這個帳戶」 */
export function learnCard(card: string | undefined, accountId: string | undefined) {
  if (!card || !accountId) return;
  const s = useSettings.getState();
  if (s.inbox.cardMap[card] === accountId) return;
  s.set('inbox', { ...s.inbox, cardMap: { ...s.inbox.cardMap, [card]: accountId } });
}

/** 一次記下多則；先寫入本機資料庫，入帳成功後才向伺服器認領刪除（避免入帳中途失敗導致伺服器資料永久遺失）。skipDuplicates：很可能重複的留在收件匣等你確認 */
export async function bookInboxEntries(entries: InboxEntry[], opts: { skipDuplicates?: boolean } = {}) {
  const ok = entries.filter((e) => e.drafts.length && !(opts.skipDuplicates && e.dup?.level === 'strong'));
  if (!ok.length) return { count: 0, skipped: 0, txIds: [], transferIds: [] };

  const txIds: string[] = [];
  const transferIds: string[] = [];
  const bookedItemIds: number[] = [];

  for (const e of ok) {
    try {
      const res = await bookDrafts(e.drafts);
      txIds.push(...res.txIds);
      transferIds.push(...res.transferIds);
      bookedItemIds.push(e.item.id);
      learnCard(e.item.card, e.drafts[0]?.accountId);
    } catch (err) {
      console.warn(`[inbox] 入帳失敗，保留於收件匣：item ${e.item.id}`, err);
    }
  }

  // 只有成功寫入本機資料庫的項目才發送 ack 從伺服器移除
  if (bookedItemIds.length > 0) {
    try {
      await ackInbox(bookedItemIds);
    } catch (err) {
      console.warn('[inbox] ackInbox 失敗，伺服器可能保留待下次同步', err);
    }
  }

  return {
    count: txIds.length + transferIds.length,
    skipped: ok.length - bookedItemIds.length,
    txIds,
    transferIds,
  };
}

/** 在記帳面板手動記好後呼叫：從收件匣移除並學習卡片 */
export async function finishInboxItem(id: string, opts: { card?: string; accountId?: string }) {
  await ackInbox([Number(id)]);
  learnCard(opts.card, opts.accountId);
}

/** 開啟 App 時：開啟「自動入帳」就直接記下看得懂的項目；白名單發送者即使沒開全域自動入帳也直接記；其餘留在收件匣 */
export async function processInboxOnStartup(): Promise<{ booked: number; pending: number; merged: number } | null> {
  if (!AUTH_ENABLED) return null;
  const entries = await loadInbox();
  if (!entries.length) return { booked: 0, pending: 0, merged: 0 };
  const st = useSettings.getState().inbox;
  const wl = st.whitelist ?? [];
  const auto = (e: InboxEntry) => st.autoBook || matchesWhitelist(e.item, wl);
  if (!entries.some(auto)) return { booked: 0, pending: entries.length, merged: 0 };
  // 不同來源、同一時間、同金額（Apple Pay 與簡訊通知同一筆付款）：幾乎確定重複，直接合併
  let merged = 0;
  const rest: InboxEntry[] = [];
  for (const e of entries) {
    if (e.dup?.certain && (await mergeDuplicate(e).catch(() => false))) merged++;
    else rest.push(e);
  }
  // 來源不夠可信的（LINE 聊天裡剛好有金額）絕不自動入帳，留給使用者確認
  const r = await bookInboxEntries(rest.filter((e) => auto(e) && !e.review), { skipDuplicates: true });
  const pending = rest.filter((e) => !e.drafts.length || e.dup?.level === 'strong' || e.review || !auto(e)).length;
  useInboxCount.getState().set(pending);
  return { booked: r.count, pending, merged };
}

/** 下拉刷新／回到前景：和開啟 App 一樣處理收件匣（自動入帳、合併重複），有入帳就提示 */
export async function refreshInbox(): Promise<void> {
  const r = await processInboxOnStartup();
  if (r?.booked || r?.merged) useUI.getState().showSnack({ text: `收件匣：自動記下 ${r.booked} 筆${r.merged ? `、合併 ${r.merged} 筆重複通知` : ''}${r.pending ? `，${r.pending} 筆待確認` : ''}` });
}

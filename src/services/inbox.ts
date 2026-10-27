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
import { create } from 'zustand';
import { api } from './api';
import { extractDate, findAccounts, findAmounts, parseEntries, toHalfWidth, type DraftEntry } from '@/domain/nlp';
import { toDateKey, todayKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';
import { AUTH_ENABLED, useAuth } from '@/stores/auth';
import { bookDrafts, fallbackAccount, parseContext, resolveDraft, type ResolvedDraft } from './quickentry';

export interface InboxRaw {
  id: number;
  source: 'applepay' | 'sms' | 'siri' | 'email' | 'other';
  text: string;
  amount: string;
  merchant: string;
  card: string;
  occurred: string;
  created_at: string;
}

export interface InboxEntry {
  item: InboxRaw;
  /** 解析出的帳目（Siri 一句話可能有多筆）；空陣列代表看不懂金額，需要手動記 */
  drafts: ResolvedDraft[];
}

export interface InboxToken { id: number; name: string; hint: string; created_at: string; last_used_at: string | null }

export const SOURCE_LABEL: Record<InboxRaw['source'], { icon: string; label: string }> = {
  applepay: { icon: '💳', label: 'Apple Pay' },
  sms: { icon: '💬', label: '簡訊' },
  siri: { icon: '🎙', label: 'Siri' },
  email: { icon: '✉️', label: 'Email' },
  other: { icon: '📥', label: '捷徑' },
};

/** 首頁提示用的待確認數 */
export const useInboxCount = create<{ n: number; set: (n: number) => void }>((set) => ({ n: 0, set: (n) => set({ n }) }));

export const hookUrl = () => `${location.origin}/api/hook/inbox`;

/** 預先做好、簽署過的捷徑（scripts/make-shortcuts.py 產生 public/shortcuts/aster-<key>.shortcut）；name＝匯入後的捷徑名稱 */
export const SHORTCUTS = [
  { key: 'siri', name: 'Aster 記一筆', icon: '🎙', title: '對 Siri 說一句話記帳', automation: null },
  { key: 'applepay', name: 'Aster Apple Pay 記帳', icon: '💳', title: 'Apple Pay 付款後自動記帳', automation: '交易' },
  { key: 'sms', name: 'Aster 簡訊記帳', icon: '💬', title: '銀行刷卡簡訊自動記帳', automation: '訊息' },
] as const;

type ShortcutDef = (typeof SHORTCUTS)[number];
export const shortcutFileUrl = (s: ShortcutDef) => `/shortcuts/aster-${s.key}.shortcut`;

/**
 * 下載捷徑檔：iOS 下載後由「捷徑」App 開啟匯入畫面，捷徑名稱取自檔名，所以用 download 屬性帶中文名稱。
 * （shortcuts://import-shortcut 只接受 iCloud 連結，自架網址會顯示「捷徑 URL 無效」）
 */
export function downloadShortcut(s: ShortcutDef) {
  const a = document.createElement('a');
  a.href = shortcutFileUrl(s);
  a.download = `${s.name}.shortcut`;
  document.body.appendChild(a);
  a.click();
  a.remove();
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

/** 取得這台裝置的連結碼；沒有就建立一組名為「iPhone 捷徑」的權杖 */
export async function ensureLink(): Promise<{ id: number; code: string; created?: InboxToken }> {
  const saved = savedLink();
  if (saved) return saved;
  const r = await createToken('iPhone 捷徑');
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

/** 簡訊／Email 裡的商店名稱：「商店:全聯」「特店名稱：Uber」「於 全家 消費」 */
export function noticeMerchant(text: string): string {
  const s = toHalfWidth(text);
  const m = s.match(/(?:商店|特店(?:名稱)?|商家|店家|消費地點|交易商店|商戶)\s*[:：]?\s*([^\s,，。;；)）]+)/)
    ?? s.match(/於\s*([^\s\d,，。]{2,20}?)\s*(?:消費|刷卡|交易)/);
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
    // 簡訊：多個金額時只取一筆（其餘多半是額度、餘額），備註換成商店名稱
    if (it.source === 'sms' || it.source === 'email') {
      const merchant = it.merchant || noticeMerchant(it.text);
      drafts = [{ ...drafts[0], note: merchant || drafts[0].note.slice(0, 40), kind: /退款|退貨|退刷/.test(it.text) ? 'income' : 'expense' }];
    }
  }
  const out: ResolvedDraft[] = [];
  for (const d of drafts) {
    const r = await resolveDraft({ ...d, accountId: byCard ?? d.accountId }, base);
    out.push(byCard ? { ...r, accountId: byCard, accountSource: 'text' } : r);
  }
  return out;
}

export async function loadInbox(): Promise<InboxEntry[]> {
  const [items, ctx, fallback] = await Promise.all([fetchInbox(), parseContext(), fallbackAccount()]);
  const out: InboxEntry[] = [];
  for (const item of items) out.push({ item, drafts: await draftsFromItem(item, ctx, fallback).catch(() => []) });
  return out;
}

/** 記住「這張卡 → 這個帳戶」 */
export function learnCard(card: string | undefined, accountId: string | undefined) {
  if (!card || !accountId) return;
  const s = useSettings.getState();
  if (s.inbox.cardMap[card] === accountId) return;
  s.set('inbox', { ...s.inbox, cardMap: { ...s.inbox.cardMap, [card]: accountId } });
}

/** 一次記下多則；先認領再記帳，回傳記了幾筆與「復原」用的 id */
export async function bookInboxEntries(entries: InboxEntry[]) {
  const ok = entries.filter((e) => e.drafts.length);
  const claimed = new Set(await ackInbox(ok.map((e) => e.item.id)));
  const mine = ok.filter((e) => claimed.has(e.item.id));
  const res = await bookDrafts(mine.flatMap((e) => e.drafts));
  for (const e of mine) learnCard(e.item.card, e.drafts[0].accountId);
  return { count: res.txIds.length + res.transferIds.length, skipped: ok.length - mine.length, ...res };
}

/** 在記帳面板手動記好後呼叫：從收件匣移除並學習卡片 */
export async function finishInboxItem(id: string, opts: { card?: string; accountId?: string }) {
  await ackInbox([Number(id)]);
  learnCard(opts.card, opts.accountId);
}

/** 開啟 App 時：開啟「自動入帳」就直接記下看得懂的項目，其餘留在收件匣 */
export async function processInboxOnStartup(): Promise<{ booked: number; pending: number } | null> {
  if (!AUTH_ENABLED) return null;
  const entries = await loadInbox();
  if (!entries.length) return { booked: 0, pending: 0 };
  if (!useSettings.getState().inbox.autoBook) return { booked: 0, pending: entries.length };
  const r = await bookInboxEntries(entries);
  const pending = entries.length - entries.filter((e) => e.drafts.length).length;
  useInboxCount.getState().set(pending);
  return { booked: r.count, pending };
}

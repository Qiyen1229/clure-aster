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
import { AUTH_ENABLED, useAuth } from '@/stores/auth';
import { bookDrafts, fallbackAccount, parseContext, resolveDraft, type ResolvedDraft } from './quickentry';

export interface InboxRaw {
  id: number;
  source: 'applepay' | 'sms' | 'siri' | 'clipboard' | 'share' | 'quick' | 'email' | 'other';
  text: string;
  amount: string;
  merchant: string;
  card: string;
  occurred: string;
  created_at: string;
  /** Email 轉寄來的帳單附件（CSV、截圖、PDF）；內容用 fetchAttachmentFile 下載 */
  attachments?: InboxAttachment[];
}

export interface InboxAttachment { id: number; filename: string; content_type: string; size: number }

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
}

export interface InboxToken { id: number; name: string; hint: string; created_at: string; last_used_at: string | null; allow_from?: string }

export const SOURCE_LABEL: Record<InboxRaw['source'], { icon: string; label: string }> = {
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
  { key: 'applepay', name: 'Aster Apple Pay 記帳', icon: '💳', title: 'Apple Pay 付款後自動記帳', automation: '交易', hint: '最推薦：付款後自動送出金額、商家、卡片' },
  { key: 'sms', name: 'Aster 簡訊記帳', icon: '💬', title: '銀行刷卡簡訊自動記帳', automation: '訊息', hint: '銀行刷卡簡訊、轉帳通知都能收' },
  { key: 'siri', name: 'Aster 記一筆', icon: '🎙', title: '對 Siri 說一句話記帳', automation: null, hint: '「嘿 Siri，Aster 記一筆」，也可以綁在動作按鈕' },
  { key: 'quick', name: 'Aster 快速記帳', icon: '⚡', title: '點一下、打一句話記帳', automation: null, hint: '放到主畫面或動作按鈕、背面輕點，跳出輸入框打「午餐 120」' },
  { key: 'clipboard', name: 'Aster 貼上記帳', icon: '📋', title: '把剪貼簿的文字送去記帳', automation: null, hint: '在銀行 App、LINE 複製一段交易明細後執行' },
  { key: 'share', name: 'Aster 分享記帳', icon: '📤', title: '從分享選單把文字送去記帳', automation: null, hint: '任何 App 的分享按鈕裡就會出現「Aster 分享記帳」' },
] as const;

type ShortcutDef = (typeof SHORTCUTS)[number];
export const shortcutFileUrl = (s: ShortcutDef) => `/shortcuts/aster-${s.key}.shortcut`;

/**
 * 把捷徑檔交給「捷徑」App 匯入。
 * 注意：不能用 shortcuts://import-shortcut?url=… ——它只接受 iCloud 分享連結，自架網址一律顯示「提供的捷徑 URL 無效」（v4.1.4 以前踩過）。
 * 做法：先在背景把六個檔案抓好（保留點擊當下的手勢）→ 按「加入」時用 iOS 分享選單（navigator.share 帶檔案），選「捷徑」就進匯入畫面；
 * 分享選單不能用（桌面、舊瀏覽器、檔案類型被拒）就改成下載檔案，再從「檔案」App 的「下載項目」點開。
 */
const fileCache = new Map<string, File>();

/** 預先抓好捷徑檔；回傳有問題的檔案（伺服器沒回傳捷徑檔：多半是還沒更新到新版、或被登入保護擋住而回傳網頁） */
export async function prefetchShortcuts(): Promise<string[]> {
  const bad: string[] = [];
  await Promise.all(SHORTCUTS.map(async (s) => {
    if (fileCache.has(s.key)) return;
    try {
      const r = await fetch(shortcutFileUrl(s), { cache: 'no-cache' });
      const blob = await r.blob();
      if (!r.ok || /text\/html/i.test(r.headers.get('content-type') ?? '') || blob.size < 1000) { bad.push(s.name); return; }
      fileCache.set(s.key, new File([blob], `${s.name}.shortcut`, { type: 'application/octet-stream' }));
    } catch { bad.push(s.name); }
  }));
  return bad;
}

/** 用瀏覽器下載捷徑檔（備用）：下載後點開檔案就會進入匯入畫面，名稱取自檔名 */
export function downloadShortcut(s: ShortcutDef) {
  const a = document.createElement('a');
  a.href = shortcutFileUrl(s);
  a.download = `${s.name}.shortcut`;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 回傳：shared＝已跳出分享選單；cancelled＝你關掉了分享選單；downloaded＝改用下載 */
export async function openShortcutImport(s: ShortcutDef): Promise<'shared' | 'cancelled' | 'downloaded'> {
  const f = fileCache.get(s.key);
  if (f && typeof navigator.share === 'function' && navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: s.name }); return 'shared'; } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  downloadShortcut(s);
  return 'downloaded';
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

// ───────────── Email 轉寄收帳單（方案 A） ─────────────
// 使用者在自己的信箱設定「銀行帳單信自動轉寄到專屬地址」，收信管道（例如 Cloudflare Email Worker）把整封信 POST 到 /api/hook/mail。
// Aster 不碰信箱帳密；信件變成收件匣項目（本文）＋附件（CSV、截圖、PDF），帳單附件可一鍵帶進「對帳」。

export const mailHookUrl = () => `${location.origin}/api/hook/mail`;
export const MAIL_TOKEN_NAME = 'Email 轉寄';

/** Email 轉寄專用的權杖（和捷徑權杖分開，可以各自撤銷）。原文只在建立時拿得到 */
export const createMailToken = () => createToken(MAIL_TOKEN_NAME);
export const setAllowFrom = (id: number, allow_from: string) => api<InboxToken>(`/inbox/tokens/${id}`, { method: 'PATCH', body: { allow_from } });

/** 貼進 Cloudflare Email Worker 的程式碼：把整封信轉成 HTTP 呼叫（ASTER_TOKEN 要設成機密變數，不要寫死在程式裡） */
export const CLOUDFLARE_WORKER_CODE = `export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const r = await fetch(env.ASTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'message/rfc822', 'X-Aster-Token': env.ASTER_TOKEN },
      body: raw,
    });
    if (!r.ok) message.setReject('Aster 暫時收不下：' + r.status);
  },
};`;

/** 下載附件成 File（App 登入中才有權限；下載後交給對帳流程） */
export async function fetchAttachmentFile(a: InboxAttachment): Promise<File> {
  const res = await fetch(`/api/inbox/attachments/${a.id}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? '附件已經處理過或過期了' : `下載失敗（${res.status}）`);
  return new File([await res.blob()], a.filename || '附件', { type: a.content_type || 'application/octet-stream' });
}

/** 帳單類的信（有附件，或本文看起來是帳單）：不能把「應繳金額」當成一筆消費自動記帳，要走對帳或手動 */
export const isStatementMail = (it: Pick<InboxRaw, 'source' | 'text' | 'attachments'>) =>
  it.source === 'email' && (!!it.attachments?.length || /電子帳單|對帳單|帳單(?:已|通知)|應繳(?:總)?金額|繳款截止/.test(it.text));

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
  if (isStatementMail(it)) return []; // 帳單信：「應繳金額」不是一筆消費，留在收件匣給你對帳
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
  for (const item of items) out.push({ item, drafts: await draftsFromItem(item, ctx, fallback).catch(() => []) });
  await markDuplicates(out, ctx.today).catch(() => undefined);
  return out;
}

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

/** 一次記下多則；先認領再記帳，回傳記了幾筆與「復原」用的 id。skipDuplicates：很可能重複的留在收件匣等你確認 */
export async function bookInboxEntries(entries: InboxEntry[], opts: { skipDuplicates?: boolean } = {}) {
  const ok = entries.filter((e) => e.drafts.length && !(opts.skipDuplicates && e.dup?.level === 'strong'));
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
export async function processInboxOnStartup(): Promise<{ booked: number; pending: number; merged: number } | null> {
  if (!AUTH_ENABLED) return null;
  const entries = await loadInbox();
  if (!entries.length) return { booked: 0, pending: 0, merged: 0 };
  if (!useSettings.getState().inbox.autoBook) return { booked: 0, pending: entries.length, merged: 0 };
  // 不同來源、同一時間、同金額（Apple Pay 與簡訊通知同一筆付款）：幾乎確定重複，直接合併
  let merged = 0;
  const rest: InboxEntry[] = [];
  for (const e of entries) {
    if (e.dup?.certain && (await mergeDuplicate(e).catch(() => false))) merged++;
    else rest.push(e);
  }
  const r = await bookInboxEntries(rest, { skipDuplicates: true });
  const pending = rest.filter((e) => !e.drafts.length || e.dup?.level === 'strong').length;
  useInboxCount.getState().set(pending);
  return { booked: r.count, pending, merged };
}

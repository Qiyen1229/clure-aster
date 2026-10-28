/**
 * 一句話記帳：把 domain/nlp 解析出的草稿補上分類與帳戶，並可一次記下多筆。
 * 分類：文字中直接寫到的分類名稱 → 自動分類規則 → 商家記憶 → 「其他」
 * 帳戶：文字中寫到的帳戶 → 規則指定的帳戶 → 同一個商家過去最常用的帳戶 → 上次使用的帳戶
 */
import { db } from '@/db/schema';
import type { Account } from '@/db/types';
import { parseEntries, type DraftEntry } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { toMinor } from '@/domain/money';
import { useSettings } from '@/stores/settings';
import { suggestAccount, suggestCategory } from './autocat';

export interface ResolvedDraft extends DraftEntry {
  accountId: string;
  categoryId?: string;
  tagIds: string[];
  categorySource: 'text' | 'rule' | 'memory' | 'default';
  accountSource: 'text' | 'rule' | 'memory' | 'default';
}

const usable = (a: Account) => !a.archived && !a.deletedAt && a.type !== 'loan';

export async function parseContext(today = todayKey()) {
  const [accounts, cats] = await Promise.all([db.accounts.orderBy('sort').toArray(), db.categories.toArray()]);
  return {
    today,
    accounts: accounts.filter(usable).map((a) => ({ id: a.id, name: a.name, type: a.type })),
    categories: cats.filter((c) => !c.archived && !c.deletedAt && !c.system).map((c) => ({ id: c.id, name: c.name, kind: c.kind, parentId: c.parentId })),
  };
}

/** 依備註補上分類與帳戶；fallbackAccountId 是沒有任何線索時使用的帳戶 */
export async function resolveDraft(d: DraftEntry, fallbackAccountId: string): Promise<ResolvedDraft> {
  const kind = d.kind === 'income' ? 'income' : 'expense';
  let categoryId = d.categoryId;
  let tagIds: string[] = [];
  let categorySource: ResolvedDraft['categorySource'] = categoryId ? 'text' : 'default';
  if (d.kind !== 'transfer' && d.note) {
    const sug = await suggestCategory(d.note, kind).catch(() => null);
    // 規則優先於文字裡的分類名稱（使用者特地設的）；商家記憶只在文字沒寫分類時使用
    if (sug && (sug.source === 'rule' || !categoryId)) {
      categoryId = sug.categoryId;
      tagIds = sug.tagIds;
      categorySource = sug.source;
    }
  }
  if (!categoryId && d.kind !== 'transfer') categoryId = kind === 'income' ? 'inc-other_inc' : 'exp-other_exp';
  let accountId = d.accountId;
  let accountSource: ResolvedDraft['accountSource'] = accountId ? 'text' : 'default';
  if (!accountId && d.note) {
    const acc = await suggestAccount(d.note, kind).catch(() => undefined);
    if (acc) { accountId = acc.accountId; accountSource = acc.source; }
  }
  return { ...d, accountId: accountId ?? fallbackAccountId, categoryId, tagIds, categorySource, accountSource };
}

/** 預設帳戶：上次記帳用的帳戶 → 第一個非負債帳戶 */
export async function fallbackAccount(): Promise<string> {
  const accs = (await db.accounts.orderBy('sort').toArray()).filter(usable);
  const last = useSettings.getState().lastAccountId;
  return (accs.find((a) => a.id === last) ?? accs.find((a) => !a.isLiability) ?? accs[0])?.id ?? '';
}

export async function draftsFromText(text: string): Promise<ResolvedDraft[]> {
  const ctx = await parseContext();
  const fallback = await fallbackAccount();
  const list = parseEntries(text, ctx);
  return Promise.all(list.map((d) => resolveDraft(d, fallback)));
}

/**
 * 一句話記帳（明確送出時使用）：先用規則解析；規則找不到金額且使用者開啟了 AI 輔助，才請 AI 解析一次。
 * 輸入中的即時預覽請用 draftsFromText，不要用這個（會消耗額度）。
 * AI 失敗不丟錯，把原因放在 aiNote，讓畫面顯示「找不到金額」＋原因。
 */
export async function draftsSmart(text: string): Promise<{ list: ResolvedDraft[]; usedAi: boolean; aiNote?: string; quotaText?: string }> {
  const list = await draftsFromText(text);
  if (list.length) return { list, usedAi: false };
  const ai = await import('./ai');
  if (!ai.aiEnabledLocally()) return { list, usedAi: false };
  try {
    const { drafts, quota } = await ai.aiParse(text);
    const fallback = await fallbackAccount();
    return { list: await Promise.all(drafts.map((d) => resolveDraft(d, fallback))), usedAi: true, quotaText: ai.quotaLabel(quota) };
  } catch (e) {
    return { list, usedAi: false, aiNote: `（AI：${(e as Error).message}）` };
  }
}

/** 一次記下多筆；回傳新增的帳目與轉帳 id（給「復原」用） */
export async function bookDrafts(list: ResolvedDraft[]): Promise<{ txIds: string[]; transferIds: string[] }> {
  const { addTransaction, addTransfer } = await import('@/db/repo/ledger');
  const accounts = new Map((await db.accounts.toArray()).map((a) => [a.id, a]));
  const txIds: string[] = [];
  const transferIds: string[] = [];
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  for (const d of list) {
    const acc = accounts.get(d.accountId);
    if (!acc) throw new Error('找不到帳戶，請先新增帳戶');
    const ts = new Date(`${d.date}T${d.date === todayKey() ? time : '12:00'}:00`).getTime();
    if (d.kind === 'transfer') {
      const to = d.toAccountId ? accounts.get(d.toAccountId) : undefined;
      if (!to || to.id === acc.id) throw new Error('轉帳需要兩個不同的帳戶');
      if (to.currency !== acc.currency) throw new Error('跨幣別轉帳請用記帳面板輸入匯率');
      const amt = toMinor(d.amount, acc.currency);
      const tr = await addTransfer({ fromAccountId: acc.id, toAccountId: to.id, fromAmountMinor: amt, toAmountMinor: amt, feeMinor: 0, date: d.date, ts, note: d.note });
      transferIds.push(tr.id);
    } else {
      const currency = d.currency ?? acc.currency;
      const tx = await addTransaction({
        type: d.kind, accountId: acc.id, categoryId: d.categoryId!, amountMinor: toMinor(d.amount, currency), currency,
        date: d.date, ts, note: d.note, tagIds: d.tagIds,
      });
      txIds.push(tx.id);
    }
  }
  if (list[0]) useSettings.getState().set('lastAccountId', list[list.length - 1].accountId);
  return { txIds, transferIds };
}

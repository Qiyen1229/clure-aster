/**
 * AI 解析結果 → 一句話記帳草稿（純函式）。
 * 伺服器回傳的是「分類／帳戶名稱」，這裡對回使用者自己的 id；對不到的留空，之後由自動分類規則與商家記憶補上。
 * 轉帳需要兩個不同的帳戶，缺一就丟棄（不猜）。
 */
import type { DraftEntry, ParseContext } from './nlp';

export interface AiEntry {
  type: 'expense' | 'income' | 'transfer';
  amount: number;
  note: string;
  category: string | null;
  account: string | null;
  to_account: string | null;
  date: string | null;
}

export function aiEntriesToDrafts(entries: AiEntry[], ctx: ParseContext, raw: string): DraftEntry[] {
  const acc = (name: string | null) => (name ? ctx.accounts.find((a) => a.name === name)?.id : undefined);
  const out: DraftEntry[] = [];
  for (const e of entries) {
    if (!(e.amount > 0)) continue;
    const accountId = acc(e.account);
    const toAccountId = acc(e.to_account);
    if (e.type === 'transfer') {
      if (!accountId || !toAccountId || accountId === toAccountId) continue;
      out.push({ kind: 'transfer', amount: e.amount, date: e.date ?? ctx.today, dateGiven: !!e.date, accountId, toAccountId, note: e.note, raw });
      continue;
    }
    const cat = e.category ? ctx.categories.find((c) => c.name === e.category && c.kind === e.type) : undefined;
    out.push({ kind: e.type, amount: e.amount, date: e.date ?? ctx.today, dateGiven: !!e.date, accountId, categoryId: cat?.id, note: e.note, raw });
  }
  return out;
}

/** 送給伺服器的名單：只送名稱（去重、限制數量），不送 id、金額與帳目 */
export function namesForAi(ctx: ParseContext): { categories: string[]; accounts: string[] } {
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  return { categories: uniq(ctx.categories.map((c) => c.name)).slice(0, 120), accounts: uniq(ctx.accounts.map((a) => a.name)).slice(0, 40) };
}

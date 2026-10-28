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

/**
 * 簡訊／通知送給 AI 前先去掉不需要的個資：網址、身分證字號、連續 10 碼以上的數字（帳號、電話）、卡號（4-4-4-4）。
 * 金額、日期、商家、卡片末四碼不動；最多 300 字（伺服器上限）。
 */
export function sanitizeForAi(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[A-Z][12]\d{8}\b/g, ' ')
    .replace(/\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{2,4}\b/g, ' ')
    .replace(/\b\d{10,}\b/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** 送給伺服器的名單：只送名稱（去重、限制數量），不送 id、金額與帳目 */
export function namesForAi(ctx: ParseContext): { categories: string[]; accounts: string[] } {
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  return { categories: uniq(ctx.categories.map((c) => c.name)).slice(0, 120), accounts: uniq(ctx.accounts.map((a) => a.name)).slice(0, 40) };
}

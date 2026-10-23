/**
 * CSV 匯入精靈的核心：欄位自動對應（含 Moze 匯出格式）、資料列轉換、轉帳配對、建立缺少的帳戶與分類、批次寫入。
 *
 * Moze 匯出 CSV 欄位（Moze 3／4）：
 *   帳戶, 幣種, 記錄類型, 主類別, 子類別, 金額, 手續費, 折扣, 名稱, 商家, 日期, 時間, 專案, 描述, 標籤, 對象
 * 記錄類型：支出／收入／轉出／轉入／餘額調整／應收款項／應付款項…；支出金額為負數。
 * 轉帳在 Moze 中以「轉出」「轉入」兩列表示，本工具會依日期、時間、金額配對成一筆轉帳。
 */
import Decimal from 'decimal.js';
import { db, uid } from '@/db/schema';
import type { Account, Category, CategoryKind, Transaction, Transfer, TxType } from '@/db/types';
import { recomputeBalances } from '@/db/repo/accounts';
import { convertMinor, currencyInfo, toMinor } from '@/domain/money';
import { resolveRate } from './fx';
import { CATEGORY_COLORS } from '@/db/seed/categories';

export type FieldKey = 'date' | 'time' | 'type' | 'amount' | 'currency' | 'account' | 'toAccount' | 'main' | 'sub' | 'note' | 'merchant' | 'tags' | 'project' | 'fee' | 'desc';

export const FIELD_LABELS: Record<FieldKey, string> = {
  date: '日期 *', time: '時間', type: '類型', amount: '金額 *', currency: '幣別', account: '帳戶 *', toAccount: '轉入帳戶',
  main: '主分類', sub: '子分類', note: '名稱／備註', merchant: '商家', tags: '標籤', project: '專案', fee: '手續費', desc: '描述',
};

const ALIASES: Record<FieldKey, string[]> = {
  date: ['日期', 'date', '交易日期'],
  time: ['時間', 'time'],
  type: ['記錄類型', '類型', 'type', '收支'],
  amount: ['金額', 'amount', '價格'],
  currency: ['幣種', '幣別', 'currency'],
  account: ['帳戶', 'account', '付款帳戶', '轉出帳戶'],
  toAccount: ['轉入帳戶', 'to account', 'toaccount'],
  main: ['主類別', '主分類', '分類', 'category'],
  sub: ['子類別', '子分類', 'subcategory'],
  note: ['名稱', '備註', 'note', 'memo', '項目'],
  merchant: ['商家', 'merchant', '店家'],
  tags: ['標籤', 'tags', 'tag'],
  project: ['專案', 'project'],
  fee: ['手續費', 'fee'],
  desc: ['描述', 'description'],
};

export type Mapping = Partial<Record<FieldKey, number>>;

export function autoMap(header: string[]): { mapping: Mapping; isMoze: boolean } {
  const norm = header.map((h) => h.trim().toLowerCase());
  const mapping: Mapping = {};
  (Object.keys(ALIASES) as FieldKey[]).forEach((k) => {
    const i = norm.findIndex((h) => ALIASES[k].some((a) => h === a.toLowerCase()));
    if (i >= 0) mapping[k] = i;
  });
  const isMoze = ['帳戶', '幣種', '記錄類型', '主類別', '子類別', '金額'].every((h) => header.includes(h));
  return { mapping, isMoze };
}

export interface ParsedRow {
  line: number;
  kind: 'expense' | 'income' | 'adjust' | 'transfer_out' | 'transfer_in' | 'skip';
  date: string;
  time: string;
  amount: Decimal; // 絕對值
  signed: Decimal;
  currency: string;
  account: string;
  toAccount: string;
  main: string;
  sub: string;
  note: string;
  tags: string[];
  project: string;
  fee: Decimal;
  error?: string;
}

/** 年月日是否為真實存在的日期 */
function validYMD(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}

/**
 * 日期正規化為 YYYY-MM-DD。支援 YYYY/MM/DD、YYYY年M月D日、MM/DD/YYYY、DD/MM/YYYY。
 * 前兩段都 ≤ 12 時無法分辨，依美式 MM/DD/YYYY；第一段 > 12 則判定為 DD/MM/YYYY。不存在的日期回傳 null。
 */
export function normDate(s: string): string | null {
  const t = s.trim().replace(/[年月]/g, '/').replace(/日/, '');
  const fmt = (y: number, m: number, d: number) => (validYMD(y, m, d) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  const m = t.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (m) return fmt(+m[1], +m[2], +m[3]);
  const m2 = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m2) {
    const a = +m2[1], b = +m2[2], y = +m2[3];
    return a > 12 && b <= 12 ? fmt(y, b, a) : fmt(y, a, b);
  }
  return null;
}

function normType(s: string, signed: Decimal): ParsedRow['kind'] {
  const t = s.trim().toLowerCase();
  if (/轉出|transfer.?out/.test(t)) return 'transfer_out';
  if (/轉入|transfer.?in/.test(t)) return 'transfer_in';
  if (/轉帳|transfer/.test(t)) return signed.isNegative() ? 'transfer_out' : 'transfer_in';
  if (/餘額|調整|adjust|balance/.test(t)) return 'adjust';
  if (/應收|應付|receivable|payable/.test(t)) return 'skip';
  if (/收入|income|退款|refund/.test(t)) return 'income';
  if (/支出|expense|消費/.test(t)) return 'expense';
  return signed.isNegative() ? 'expense' : t ? 'expense' : 'income';
}

export function parseRows(rows: string[][], mapping: Mapping, defaults: { currency: string; account: string }): ParsedRow[] {
  const get = (r: string[], k: FieldKey) => (mapping[k] !== undefined ? (r[mapping[k]!] ?? '').trim() : '');
  return rows.map((r, i) => {
    const rawAmt = get(r, 'amount').replace(/[,\s$NT＄]/g, '');
    let signed: Decimal;
    try { signed = new Decimal(rawAmt || 'x'); } catch { signed = new Decimal(NaN); }
    const date = normDate(get(r, 'date'));
    const note = [get(r, 'note'), get(r, 'merchant') && get(r, 'merchant') !== get(r, 'note') ? `@${get(r, 'merchant')}` : '', get(r, 'desc')].filter(Boolean).join(' ');
    let fee: Decimal;
    try { fee = new Decimal(get(r, 'fee').replace(/,/g, '') || 0).abs(); } catch { fee = new Decimal(0); }
    const row: ParsedRow = {
      line: i + 2, kind: normType(get(r, 'type'), signed), date: date ?? '', time: (get(r, 'time') || '12:00').slice(0, 5),
      amount: signed.isNaN() ? new Decimal(0) : signed.abs(), signed, currency: (get(r, 'currency') || defaults.currency).toUpperCase(),
      account: get(r, 'account') || defaults.account, toAccount: get(r, 'toAccount'), main: get(r, 'main'), sub: get(r, 'sub'),
      note, tags: get(r, 'tags').split(/[|,，、#\s]+/).map((x) => x.trim()).filter(Boolean), project: get(r, 'project'), fee,
    };
    if (!date) row.error = '日期格式無法辨識';
    else if (signed.isNaN()) row.error = '金額不是數字';
    else if (!row.account) row.error = '缺少帳戶';
    if (row.kind === 'adjust') row.amount = signed; // 調整保留正負
    return row;
  });
}

export interface ImportPlan {
  txs: number;
  transfers: number;
  skipped: number;
  errors: ParsedRow[];
  newAccounts: string[];
  newCategories: string[];
}

/** 配對轉出／轉入；有 toAccount 欄位的單列轉帳直接成立 */
function pairTransfers(rows: ParsedRow[]) {
  const pairs: { out: ParsedRow; in?: ParsedRow }[] = [];
  const ins = rows.filter((r) => r.kind === 'transfer_in' && !r.error);
  const used = new Set<ParsedRow>();
  for (const o of rows.filter((r) => r.kind === 'transfer_out' && !r.error)) {
    if (o.toAccount) { pairs.push({ out: o }); continue; }
    const match = ins.find((i) => !used.has(i) && i.date === o.date && i.time === o.time && i.account !== o.account)
      ?? ins.find((i) => !used.has(i) && i.date === o.date && i.account !== o.account && (i.currency !== o.currency || i.amount.eq(o.amount)));
    if (match) used.add(match);
    pairs.push({ out: o, in: match });
  }
  const orphanIns = ins.filter((i) => !used.has(i) && !i.toAccount);
  return { pairs, orphanIns };
}

export async function planImport(rows: ParsedRow[]): Promise<ImportPlan> {
  const accounts = await db.accounts.toArray();
  const cats = await db.categories.toArray();
  const accNames = new Set(accounts.map((a) => a.name));
  const newAccounts = new Set<string>();
  const newCategories = new Set<string>();
  for (const r of rows) {
    if (r.error || r.kind === 'skip') continue;
    for (const n of [r.account, r.toAccount]) if (n && !accNames.has(n)) newAccounts.add(n);
    if ((r.kind === 'expense' || r.kind === 'income') && r.main) {
      const kind: CategoryKind = r.kind;
      const main = cats.find((c) => c.kind === kind && !c.parentId && c.name === r.main);
      if (!main) newCategories.add(`${kind === 'expense' ? '支出' : '收入'}：${r.main}${r.sub ? ` › ${r.sub}` : ''}`);
      else if (r.sub && !cats.some((c) => c.parentId === main.id && c.name === r.sub)) newCategories.add(`${r.main} › ${r.sub}`);
    }
  }
  const { pairs, orphanIns } = pairTransfers(rows);
  return {
    txs: rows.filter((r) => !r.error && ['expense', 'income', 'adjust'].includes(r.kind)).length + orphanIns.length + pairs.filter((p) => !p.in && !p.out.toAccount).length,
    transfers: pairs.filter((p) => p.in || p.out.toAccount).length,
    skipped: rows.filter((r) => r.kind === 'skip').length,
    errors: rows.filter((r) => r.error),
    newAccounts: [...newAccounts],
    newCategories: [...newCategories],
  };
}

/** 執行匯入：批次寫入後全量重算帳戶餘額。回傳寫入筆數 */
export async function runImport(rows: ParsedRow[], base: string): Promise<{ txs: number; transfers: number }> {
  const now = Date.now();
  const accounts = await db.accounts.toArray();
  const cats = await db.categories.toArray();
  const projects = await db.projects.toArray();
  const tags = await db.tags.toArray();
  const rates = new Map((await db.exchange_rates.toArray()).map((r) => [`${r.base}>${r.quote}`, r]));
  const accByName = new Map(accounts.map((a) => [a.name, a]));
  const newAccs: Account[] = [];
  const newCats: Category[] = [];
  const newTags = new Map<string, string>();

  const account = (name: string, currency: string): Account => {
    let a = accByName.get(name);
    if (!a) {
      const credit = /卡|card|credit/i.test(name);
      a = {
        id: uid(), name, icon: credit ? '💳' : '🏦', color: CATEGORY_COLORS[(accByName.size + 6) % CATEGORY_COLORS.length],
        type: credit ? 'credit' : /現金|cash|錢包/i.test(name) ? 'cash' : 'bank', currency: currencyInfo(currency).code,
        initialBalanceMinor: 0, balanceMinor: 0, includeInNetWorth: true, isLiability: credit, sort: accByName.size, archived: 0, createdAt: now, updatedAt: now,
      };
      accByName.set(name, a);
      newAccs.push(a);
    }
    return a;
  };
  const category = (kind: CategoryKind, main: string, sub: string): string => {
    if (!main) return kind === 'expense' ? 'exp-other_exp' : 'inc-other_inc';
    const all = [...cats, ...newCats];
    let m = all.find((c) => c.kind === kind && !c.parentId && c.name === main);
    if (!m) {
      m = { id: uid(), kind, parentId: '', name: main, icon: '🏷️', color: CATEGORY_COLORS[all.length % CATEGORY_COLORS.length], sort: 100 + newCats.length, archived: 0, createdAt: now, updatedAt: now };
      newCats.push(m);
    }
    if (!sub) return m.id;
    let s = all.find((c) => c.parentId === m!.id && c.name === sub);
    if (!s) {
      s = { id: uid(), kind, parentId: m.id, name: sub, icon: m.icon, color: m.color, sort: 100 + newCats.length, archived: 0, createdAt: now, updatedAt: now };
      newCats.push(s);
    }
    return s.id;
  };
  const tagIds = (names: string[]) => names.map((n) => {
    const t = tags.find((x) => x.name === n);
    if (t) return t.id;
    if (!newTags.has(n)) newTags.set(n, uid());
    return newTags.get(n)!;
  });
  const projectId = (name: string) => (name ? projects.find((p) => p.name === name)?.id : undefined);
  const amounts = (amountMinor: number, cur: string, acc: Account) => {
    const r1 = cur === acc.currency ? '1' : resolveRate(rates, cur, acc.currency);
    const accountAmountMinor = convertMinor(amountMinor, cur, acc.currency, r1 ?? 1);
    const r2 = acc.currency === base ? '1' : resolveRate(rates, acc.currency, base);
    return { accountAmountMinor, baseAmountMinor: convertMinor(accountAmountMinor, acc.currency, base, r2 ?? 1), fxRateDec: cur === acc.currency ? undefined : r1?.toString() };
  };

  const txs: Transaction[] = [];
  const trs: Transfer[] = [];
  const ts = (r: ParsedRow) => new Date(`${r.date}T${/^\d{1,2}:\d{2}/.test(r.time) ? r.time.padStart(5, '0') : '12:00'}:00`).getTime();
  const mkTx = (r: ParsedRow, type: TxType, categoryId: string) => {
    const acc = account(r.account, r.currency);
    const amt = toMinor(r.amount, r.currency);
    const a = amounts(amt, r.currency, acc);
    txs.push({
      id: uid(), type, accountId: acc.id, categoryId, amountMinor: amt, currency: r.currency, ...a,
      baseAmountMinor: type === 'adjust' ? a.baseAmountMinor : Math.abs(a.baseAmountMinor),
      date: r.date, ts: ts(r), note: r.note, tagIds: tagIds(r.tags), projectId: projectId(r.project), attachmentIds: [],
      excludeFromStats: type === 'adjust', createdAt: now, updatedAt: now,
    });
  };

  for (const r of rows) {
    if (r.error || r.kind === 'skip' || r.kind === 'transfer_in' || r.kind === 'transfer_out') continue;
    if (r.kind === 'adjust') mkTx(r, 'adjust', 'sys-adjust');
    else mkTx(r, r.kind, category(r.kind, r.main, r.sub));
    if (r.fee.gt(0) && (r.kind === 'expense' || r.kind === 'income')) {
      mkTx({ ...r, amount: r.fee, note: `${r.note} 手續費`.trim() }, 'expense', 'exp-tax-bankfee');
    }
  }
  const { pairs, orphanIns } = pairTransfers(rows);
  for (const p of pairs) {
    const o = p.out;
    const toName = o.toAccount || p.in?.account;
    if (!toName) { mkTx(o, 'expense', category('expense', o.main || '轉帳', '')); continue; }
    const from = account(o.account, o.currency);
    const to = account(toName, p.in?.currency ?? o.currency);
    const fromAmt = toMinor(o.amount, from.currency);
    const toAmt = p.in ? toMinor(p.in.amount, to.currency) : from.currency === to.currency ? fromAmt : amounts(fromAmt, from.currency, to).accountAmountMinor;
    const id = uid();
    const feeMinor = o.fee.gt(0) ? toMinor(o.fee, from.currency) : 0;
    let feeTransactionId: string | undefined;
    if (feeMinor) {
      const a = amounts(feeMinor, from.currency, from);
      feeTransactionId = uid();
      txs.push({ id: feeTransactionId, type: 'transfer_fee', accountId: from.id, categoryId: 'sys-transfer-fee', amountMinor: feeMinor, currency: from.currency, ...a, baseAmountMinor: Math.abs(a.baseAmountMinor), date: o.date, ts: ts(o), note: '轉帳手續費', tagIds: [], attachmentIds: [], transferId: id, createdAt: now, updatedAt: now });
    }
    trs.push({
      id, fromAccountId: from.id, toAccountId: to.id, fromAmountMinor: fromAmt, toAmountMinor: toAmt, feeMinor,
      feeAccountId: feeMinor ? from.id : undefined, feeTransactionId, date: o.date, ts: ts(o), note: o.note, tagIds: tagIds(o.tags),
      projectId: projectId(o.project), createdAt: now, updatedAt: now,
    });
  }
  for (const i of orphanIns) mkTx(i, 'income', category('income', i.main || '轉入', ''));

  await db.transaction('rw', [db.accounts, db.categories, db.tags, db.transactions, db.transfers], async () => {
    if (newAccs.length) await db.accounts.bulkAdd(newAccs);
    if (newCats.length) await db.categories.bulkAdd(newCats);
    if (newTags.size) await db.tags.bulkAdd([...newTags].map(([name, id], k) => ({ id, name, color: CATEGORY_COLORS[k % CATEGORY_COLORS.length], sort: tags.length + k, createdAt: now, updatedAt: now })));
    await db.transactions.bulkAdd(txs);
    await db.transfers.bulkAdd(trs);
  });
  await recomputeBalances(true);
  return { txs: txs.filter((t) => !t.transferId).length, transfers: trs.length };
}

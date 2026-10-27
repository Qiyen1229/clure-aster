/**
 * 用問的查帳：執行 domain/nlquery 解析出的查詢，回答一句話並列出符合的帳目。
 */
import { db } from '@/db/schema';
import type { Category, Transaction } from '@/db/types';
import { countsInStats, statAmount } from '@/domain/ledger';
import { formatMoney } from '@/domain/money';
import { normText } from '@/domain/rules';
import { parseQuery, rangeText, type NlQuery } from '@/domain/nlquery';
import { eachDay, todayKey } from '@/domain/period';
import { pctChange } from '@/domain/reports';
import { useSettings } from '@/stores/settings';
import { parseContext } from './quickentry';

export interface QueryAnswer {
  query: NlQuery;
  /** 一句話的答案 */
  answer: string;
  /** 補充（例如其次的分類） */
  detail?: string;
  items: Transaction[];
}

export async function parseQuestion(text: string): Promise<NlQuery | null> {
  const s = useSettings.getState();
  const ctx = await parseContext();
  return parseQuery(text, { ...ctx, today: todayKey(), weekStart: s.weekStart, monthStartDay: s.monthStartDay });
}

function matcher(q: NlQuery, cats: Map<string, Category>) {
  const catSet = new Set(q.categoryIds);
  for (const c of cats.values()) if (c.parentId && catSet.has(c.parentId)) catSet.add(c.id);
  const kw = q.keyword ? normText(q.keyword) : '';
  return (t: Transaction) => {
    if (!countsInStats(t) || t.transferId) return false;
    if ((t.type === 'income') !== (q.kind === 'income')) return false;
    if (catSet.size && !catSet.has(t.categoryId)) return false;
    if (q.accountIds.length && !q.accountIds.includes(t.accountId)) return false;
    if (kw && !normText(`${t.note} ${t.merchant ?? ''}`).includes(kw) && !normText(cats.get(t.categoryId)?.name ?? '').includes(kw)) return false;
    return true;
  };
}

export async function answerQuestion(q: NlQuery): Promise<QueryAnswer> {
  const base = useSettings.getState().baseCurrency;
  const money = (v: number) => formatMoney(v, base, { decimals: 0 });
  const cats = new Map((await db.categories.toArray()).map((c) => [c.id, c]));
  const match = matcher(q, cats);
  const load = async (r: { start: string; end: string }) =>
    (await db.transactions.where('date').between(r.start, r.end, true, true).toArray()).filter(match);
  const items = (await load(q.range)).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  const total = items.reduce((s, t) => s + statAmount(t), 0);
  const verb = q.kind === 'income' ? '收入' : '支出';
  const what = [q.categoryLabel && `「${q.categoryLabel}」`, q.keyword && `「${q.keyword}」`].filter(Boolean).join('');
  const subject = `${q.rangeLabel}${what}`;
  const nameOf = (t: Transaction) => t.note || t.merchant || cats.get(t.categoryId)?.name || '';

  if (!items.length) return { query: q, answer: `${subject}沒有符合的${verb}。`, items };

  switch (q.metric) {
    case 'count':
      return { query: q, answer: `${subject}共 ${items.length} 筆，合計 ${money(total)}。`, items };
    case 'avg':
      return { query: q, answer: `${subject}平均每筆 ${money(Math.round(total / items.length))}（${items.length} 筆）。`, items };
    case 'avgDaily': {
      const end = q.range.end > todayKey() ? todayKey() : q.range.end;
      const days = Math.max(1, eachDay({ start: q.range.start, end }).length);
      return { query: q, answer: `${subject}平均每天${q.kind === 'income' ? '收入' : '花'} ${money(Math.round(total / days))}（${days} 天共 ${money(total)}）。`, items };
    }
    case 'max': {
      const top = items.reduce((a, b) => (statAmount(b) > statAmount(a) ? b : a));
      return { query: q, answer: `${subject}最大一筆：${nameOf(top)} ${money(statAmount(top))}（${rangeText({ start: top.date, end: top.date })}）。`, items: [top, ...items.filter((t) => t !== top)] };
    }
    case 'topCategory': {
      const by = new Map<string, number>();
      for (const t of items) { const c = cats.get(t.categoryId); const id = c?.parentId || t.categoryId; by.set(id, (by.get(id) ?? 0) + statAmount(t)); }
      const list = [...by].sort((a, b) => b[1] - a[1]);
      const [first, ...others] = list;
      const pct = total ? Math.round((first[1] / total) * 100) : 0;
      return {
        query: q, items,
        answer: `${subject}${verb}最多的是「${cats.get(first[0])?.name ?? '其他'}」${money(first[1])}（占 ${pct}%）。`,
        detail: others.length ? `其次：${others.slice(0, 3).map(([id, v]) => `${cats.get(id)?.name ?? '其他'} ${money(v)}`).join('、')}` : undefined,
      };
    }
    case 'topMerchant': {
      const by = new Map<string, { n: number; v: number }>();
      // 備註只是分類名稱（「晚餐」）的不算店家
      const catNames = new Set([...cats.values()].map((c) => c.name));
      for (const t of items) {
        const k = (t.merchant || t.note || '').trim();
        if (!k || catNames.has(k)) continue;
        const x = by.get(k) ?? { n: 0, v: 0 };
        x.n++; x.v += statAmount(t);
        by.set(k, x);
      }
      const list = [...by].sort((a, b) => b[1].n - a[1].n || b[1].v - a[1].v);
      if (!list.length) return { query: q, answer: `${subject}的帳目都沒有寫備註或商家，看不出常去哪裡。`, items };
      const [[name, x], ...others] = list;
      return {
        query: q, items,
        answer: `${subject}最常去「${name}」：${x.n} 次、${money(x.v)}。`,
        detail: others.length ? `其次：${others.slice(0, 3).map(([k, y]) => `${k}（${y.n} 次）`).join('、')}` : undefined,
      };
    }
    default: {
      const prev = (await load(q.prevRange)).reduce((s, t) => s + statAmount(t), 0);
      const pct = pctChange(total, prev);
      // 「9 月」這種以數字開頭的名稱前後補空格
      const pl = /^\d/.test(q.prevLabel) ? ` ${q.prevLabel} ` : q.prevLabel;
      const cmp = pct === null ? '' : Math.abs(pct) < 3 ? `，和${pl}差不多` : `，比${pl}${pct > 0 ? '多' : '少'} ${Math.abs(Math.round(pct))}%`;
      return { query: q, answer: `${subject}${verb} ${money(total)}（${items.length} 筆）${cmp}。`, items };
    }
  }
}

export async function ask(text: string): Promise<QueryAnswer | null> {
  const q = await parseQuestion(text);
  return q ? answerQuestion(q) : null;
}

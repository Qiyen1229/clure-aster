/**
 * 對話框的本機回答（不用 AI、不扣額度、不送出任何資料）：
 *  - 問帳戶餘額：「我的中國信託有多少錢」「我總共有多少錢」「淨資產」
 *  - 問預算：「我這個月還能花多少」「預算夠不夠」「飲食預算用了多少」
 * 這些都是 App 本來就有的精確數字，直接算比請 AI 看去識別化摘要更準，也不需要開啟 AI。
 */
import { db } from '@/db/schema';
import { computeBudgets } from '@/db/repo/plan';
import { formatMoney } from '@/domain/money';
import { findAccounts, findCategory } from '@/domain/nlp';
import { useSettings } from '@/stores/settings';
import { parseContext } from './quickentry';

export interface LocalAnswer { text: string; sub?: string; link?: { label: string; to: string } }

const SPEND_WORDS = /花|支出|收入|開銷|花費|賺|領到|進帳|薪水|消費/;
const BALANCE_ASK = /多少錢|有多少|剩多少|還有多少|餘額|存款|現在多少|目前多少|身價|淨資產|總資產|資產有/;
const MY_MONEY = /我的?(錢|帳戶|資產|存款|現金|錢包)|淨資產|總資產|身價|全部.{0,4}多少|總共.{0,4}多少/;

/** 帳戶餘額：指名某個帳戶就回那個；問總共／淨資產就列出各帳戶與合計（主幣別） */
export async function accountTalk(text: string): Promise<LocalAnswer | null> {
  const t = text.trim();
  if (t.length > 30 || SPEND_WORDS.test(t) || !BALANCE_ASK.test(t)) return null;
  const ctx = await parseContext();
  const base = useSettings.getState().baseCurrency;
  const hits = findAccounts(t, ctx.accounts);
  const accounts = (await db.accounts.toArray()).filter((a) => !a.archived && !a.deletedAt);
  const fmt = (a: { balanceMinor: number; currency: string }) => formatMoney(a.balanceMinor, a.currency, { decimals: 0 });
  const line = (a: (typeof accounts)[number]) => {
    if (a.type === 'credit' || a.isLiability || a.type === 'loan') return `${a.name}：欠 ${formatMoney(Math.abs(Math.min(a.balanceMinor, 0)) || Math.abs(a.balanceMinor), a.currency, { decimals: 0 })}`;
    return `${a.name}：${fmt(a)}`;
  };
  if (hits.length) {
    const rows = hits.map((h) => accounts.find((a) => a.id === h.id)).filter((a): a is (typeof accounts)[number] => !!a);
    if (rows.length) return { text: rows.map(line).join('\n'), sub: '這是 App 裡記錄的餘額，和銀行實際的可能有時間差', link: rows.length === 1 ? { label: '查看帳戶明細', to: `/accounts/${rows[0].id}` } : undefined };
  }
  if (!MY_MONEY.test(t)) return null;
  const inNet = accounts.filter((a) => a.includeInNetWorth);
  if (!inNet.length) return { text: '還沒有任何帳戶。先到「帳戶」新增一個，我才算得出你有多少錢。', link: { label: '前往帳戶', to: '/accounts' } };
  const sameCur = inNet.filter((a) => a.currency === base);
  const total = sameCur.reduce((s, a) => s + a.balanceMinor, 0);
  const foreign = inNet.filter((a) => a.currency !== base);
  const lines = [`淨資產（${base} 帳戶合計）：${formatMoney(total, base, { decimals: 0 })}`, ...inNet.slice(0, 8).map(line)];
  if (inNet.length > 8) lines.push(`…還有 ${inNet.length - 8} 個帳戶`);
  return { text: lines.join('\n'), sub: foreign.length ? `外幣帳戶（${foreign.map((a) => a.name).join('、')}）沒有換算進合計；完整淨資產（含投資市值）在「帳戶」頁` : '不含投資市值；完整淨資產在「帳戶」頁', link: { label: '前往帳戶', to: '/accounts' } };
}

const BUDGET_WORDS = /預算|還能花|還可以花|還可以用|還能用|可以花多少|今天能花|今天可以花|今日額度/;
const BUDGET_ASK = /剩|還能|還可以|可以花|超支|用了|快爆|爆了|夠不夠|狀況|進度|怎麼樣|如何|多少|分析|檢討|看看|看一下|有沒有/;

/** 預算對話：直接用預算頁同一套計算（今日額度、剩餘、預估期末、哪些快超支） */
export async function budgetTalk(text: string): Promise<LocalAnswer | null> {
  const t = text.trim();
  if (t.length > 40 || !BUDGET_WORDS.test(t) || !(BUDGET_ASK.test(t) || /還能花|還可以花|可以花多少/.test(t))) return null;
  // 「設…預算」「把預算調成…」是要改預算，交給操作助手（looksLikeOperation 會先攔截），這裡不處理
  if (/(設定?|建立|新增|調整|調高|調低|提高|降低|改成|調成)/.test(t) && /預算/.test(t)) return null;
  const views = await computeBudgets();
  if (!views.length) return { text: '你還沒有設定任何預算。可以直接說「設飲食每月預算 8000」或「依過去 3 個月的花費，幫我設定各分類的每月預算」。', link: { label: '前往預算', to: '/plan?tab=budget' } };
  const ctx = await parseContext();
  const cat = findCategory(t, ctx.categories);
  const money = (v: number, cur: string) => formatMoney(v, cur, { decimals: 0 });
  const one = (v: (typeof views)[number]) => {
    const s = v.status, cur = v.budget.currency;
    const lvl = s.level === 'over' ? '（已超支）' : s.level === 'warn' ? '（快超過提醒線）' : '';
    return `「${v.budget.name}」已用 ${money(s.spent, cur)} / ${money(s.limit, cur)}（${Math.round(s.pct)}%）${lvl}，剩 ${money(s.remaining, cur)}；${s.daysLeft > 0 ? `還有 ${s.daysLeft} 天，平均每天可花 ${money(Math.max(0, s.dailyAllowance), cur)}` : '這一期已結束'}`;
  };
  const picked = cat ? views.filter((v) => v.budget.categoryId === cat.id || v.budget.name.includes(cat.name)) : [];
  if (cat && picked.length) return { text: picked.map(one).join('\n'), link: { label: '前往預算', to: '/plan?tab=budget' } };
  const total = views.find((v) => !v.budget.categoryId);
  const lines: string[] = [];
  if (total) {
    const s = total.status, cur = total.budget.currency;
    lines.push(one(total));
    lines.push(`今天還可以花 ${money(s.todayLeft, cur)}（今日額度 ${money(s.todayBudget, cur)}，今天已花 ${money(s.spentToday, cur)}）`);
    if (total.projection && s.projected > s.limit) lines.push(`照目前的花法，預估期末會花到 ${money(s.projected, cur)}，超出預算 ${money(s.projected - s.limit, cur)}。建議之後每天控制在 ${money(Math.max(0, s.dailyAllowance), cur)} 以內。`);
    else if (s.level === 'ok') lines.push('照目前的花法，這一期預算是夠的。');
  }
  const risky = views.filter((v) => v.budget.categoryId && v.status.level !== 'ok').slice(0, 3);
  if (risky.length) lines.push(`需要留意：${risky.map((v) => `${v.budget.name} ${Math.round(v.status.pct)}%`).join('、')}`);
  if (!total) lines.push(...views.slice(0, 4).map(one));
  return { text: lines.join('\n'), sub: '想調整的話，直接說「把飲食預算調成 8000」', link: { label: '前往預算', to: '/plan?tab=budget' } };
}

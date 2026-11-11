/**
 * 對話框的本機回答（不用 AI、不扣額度、不送出任何資料）：
 *  - 問帳戶餘額／負債：「我的中國信託有多少錢」「我總共有多少錢」「淨資產」「我負債多少」「欠多少卡費」
 *  - 問預算：「我這個月還能花多少」「預算夠不夠」「飲食預算用了多少」
 *  - 問耐用品：「我有幾件耐用品」「耐用品每天多少錢」「iPhone 每天攤多少」
 *  - 問應收／應付借貸：「誰欠我錢」「我欠誰錢」「欠款狀況」
 *  - 問專案進度：「專案進度」「有哪些專案」「日本旅遊花了多少」
 *  - 問存錢目標：「存錢目標進度」「存了多少錢」
 *  - 問固定扣款／訂閱：「每個月固定扣款多少」「訂閱多少錢」
 * 這些都是 App 本來就有的精確數字，直接算比請 AI 看去識別化摘要更準，零延遲也不需聯網或消耗額度。
 */
import { db } from '@/db/schema';
import { computeBudgets, goalSaved, projectStats } from '@/db/repo/plan';
import { durableStats, lifeLabel, totalDailyBurn } from '@/domain/durable';
import { netByPerson } from '@/domain/debt';
import { formatMoney } from '@/domain/money';
import { findAccounts, findCategory } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { timesPerYear } from '@/domain/recurrence';
import { useSettings } from '@/stores/settings';
import { parseContext } from './quickentry';

export interface LocalAnswer { text: string; sub?: string; link?: { label: string; to: string } }

const SPEND_WORDS = /花|支出|收入|開銷|花費|賺|領到|進帳|薪水|消費/;
const BALANCE_ASK = /多少錢|有多少|剩多少|還有多少|餘額|存款|現在多少|目前多少|身價|淨資產|總資產|資產有|負債|卡費|信用卡欠款|貸款剩餘|總負債/;
const MY_MONEY = /我的?(錢|帳戶|資產|存款|現金|錢包)|淨資產|總資產|身價|全部.{0,4}多少|總共.{0,4}多少/;
const LIABILITY_ASK = /負債|卡費|信用卡欠款|貸款剩餘|總負債/;

/** 帳戶餘額／負債：指名某個帳戶就回那個；問總共／淨資產或負債就列出各帳戶與合計（主幣別） */
export async function accountTalk(text: string): Promise<LocalAnswer | null> {
  const t = text.trim();
  if (t.length > 35 || SPEND_WORDS.test(t) || !BALANCE_ASK.test(t)) return null;
  // 若包含人際借貸詞，交給 debtTalk 處理
  if (/誰欠我|我欠誰|別人欠|欠朋友|朋友欠|借給|分帳/.test(t)) return null;

  const ctx = await parseContext();
  const base = useSettings.getState().baseCurrency;
  const hits = findAccounts(t, ctx.accounts);
  const accounts = (await db.accounts.toArray()).filter((a) => !a.archived && !a.deletedAt);
  const fmt = (a: { balanceMinor: number; currency: string }) => formatMoney(a.balanceMinor, a.currency, { decimals: 0 });
  const line = (a: (typeof accounts)[number]) => {
    if (a.type === 'credit' || a.isLiability || a.type === 'loan') {
      const owed = Math.abs(Math.min(a.balanceMinor, 0)) || Math.abs(a.balanceMinor);
      return `${a.name}：欠 ${formatMoney(owed, a.currency, { decimals: 0 })}`;
    }
    return `${a.name}：${fmt(a)}`;
  };

  if (hits.length) {
    const rows = hits.map((h) => accounts.find((a) => a.id === h.id)).filter((a): a is (typeof accounts)[number] => !!a);
    if (rows.length) return { text: rows.map(line).join('\n'), sub: '這是 App 裡記錄的餘額，和銀行實際的可能有時間差', link: rows.length === 1 ? { label: '查看帳戶明細', to: `/accounts/${rows[0].id}` } : undefined };
  }

  // 負債查詢
  if (LIABILITY_ASK.test(t)) {
    const debts = accounts.filter((a) => a.isLiability || a.type === 'credit' || a.type === 'loan');
    if (!debts.length) return { text: '你目前沒有記錄任何負債或信用卡帳戶。', link: { label: '前往帳戶', to: '/accounts' } };
    const sameCur = debts.filter((a) => a.currency === base);
    const totalDebt = sameCur.reduce((s, a) => s + (Math.abs(Math.min(a.balanceMinor, 0)) || (a.isLiability ? Math.abs(a.balanceMinor) : 0)), 0);
    const lines = [`負債總額（${base} 帳戶合計）：約 ${formatMoney(totalDebt, base, { decimals: 0 })}`, ...debts.map(line)];
    return { text: lines.join('\n'), sub: '包含信用卡已刷未結與貸款餘額；完整財務狀況在「帳戶」頁', link: { label: '前往帳戶', to: '/accounts' } };
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

const DURABLE_WORDS = /耐用品|持有成本|每日持有|每天持有|分攤成本|每天攤多少|每天多少錢/;

/** 耐用品對話：查詢在用件數、每天分攤合計、單項物品每日持有成本與壽命進度 */
export async function durableTalk(text: string): Promise<LocalAnswer | null> {
  const t = text.trim();
  if (t.length > 40) return null;
  const durables = (await db.durables.toArray()).filter((d) => !d.deletedAt);
  const active = durables.filter((d) => d.status === 'active');
  const today = todayKey();
  const base = useSettings.getState().baseCurrency;

  // 1. 若指名特定耐用品名稱（例如「iPhone 每天多少錢」）
  const hit = active.find((d) => t.includes(d.name));
  if (hit && (DURABLE_WORDS.test(t) || /(每天|每日|攤|成本|花多少|多少錢|已用|壽命)/.test(t))) {
    const s = durableStats(hit, today);
    const lines = [
      `「${hit.name}」已使用 ${s.days.toLocaleString()} 天，購入價 ${formatMoney(hit.costMinor, hit.currency, { decimals: 0 })}`,
      `平均每天持有成本：${formatMoney(s.perDayMinor, hit.currency, { decimals: 1 })}／天`,
    ];
    if (hit.lifeYears) {
      lines.push(`預計使用 ${lifeLabel(hit.lifeYears)}（目標每天 ${formatMoney(s.targetPerDayMinor ?? 0, hit.currency, { decimals: 1 })}）`);
    }
    return { text: lines.join('\n'), sub: '用越久每天越划算，賣掉時會扣除殘值計算真實成本', link: { label: '前往耐用品', to: '/plan?tab=durable' } };
  }

  // 2. 整體耐用品問答
  if (!DURABLE_WORDS.test(t) && !/我有幾件耐用品|耐用品.*(有哪些|多少|清單)/.test(t)) return null;
  if (!active.length) {
    return { text: '你目前沒有正在追蹤的耐用品。買了大件物品（如手機、家電、機車）時可以在記帳時標記「耐用品」，每天看它攤多少錢。', link: { label: '前往耐用品', to: '/plan?tab=durable' } };
  }

  const burn = totalDailyBurn(active, today, base);
  const lines = [
    `目前正在使用 ${active.length} 件耐用品，每天合計持有成本：${formatMoney(burn, base, { decimals: 0 })}／天`,
    ...active.slice(0, 5).map((d) => {
      const s = durableStats(d, today);
      return `${d.icon} ${d.name}：${formatMoney(s.perDayMinor, d.currency, { decimals: 1 })}／天（已用 ${s.days} 天）`;
    }),
  ];
  if (active.length > 5) lines.push(`…還有 ${active.length - 5} 件耐用品`);
  return { text: lines.join('\n'), sub: '在「計畫 → 耐用品」可檢視完整攤提進度與淘汰記錄', link: { label: '前往耐用品', to: '/plan?tab=durable' } };
}

const DEBT_WORDS = /誰欠我|我欠誰|別人欠|欠我|借出|借入|借錢|借款|分帳未結|應收|應付/;

/** 人際應收／應付借貸：統計未結清款項、誰欠我錢、我欠誰錢 */
export async function debtTalk(text: string): Promise<LocalAnswer | null> {
  const t = text.trim();
  if (t.length > 40 || !DEBT_WORDS.test(t)) return null;
  // 排除銀行卡費/貸款
  if (/信用卡|卡費|房貸|車貸|信貸/.test(t)) return null;

  const debts = (await db.debts.toArray()).filter((d) => !d.deletedAt && !d.settled);
  const people = await db.people.toArray();
  const pmap = new Map(people.map((p) => [p.id, p]));
  const net = netByPerson(debts);
  const base = useSettings.getState().baseCurrency;

  let owedToMe = 0, iOwe = 0;
  for (const byCur of net.values()) {
    const v = byCur.get(base) ?? 0;
    if (v > 0) owedToMe += v; else iOwe += -v;
  }
  const rows = [...net.entries()].filter(([, m]) => [...m.values()].some((v) => v !== 0));

  if (!rows.length) {
    return { text: '目前沒有任何未結清的借貸或分帳帳款。', link: { label: '前往應收／應付', to: '/plan?tab=debt' } };
  }

  // 詢問特定對象（例如「小明欠我多少」）
  const hitPerson = people.find((p) => t.includes(p.name));
  if (hitPerson && net.has(hitPerson.id)) {
    const byCur = net.get(hitPerson.id)!;
    const lines = [...byCur.entries()].filter(([, v]) => v !== 0).map(([cur, v]) => `${hitPerson.name}：${v > 0 ? `欠你 ${formatMoney(v, cur, { decimals: 0 })}` : `你欠他 ${formatMoney(-v, cur, { decimals: 0 })}`}`);
    return { text: lines.join('\n'), link: { label: '前往應收／應付', to: '/plan?tab=debt' } };
  }

  const lines = [
    `應收（別人欠我）：${formatMoney(owedToMe, base, { decimals: 0 })}・應付（我欠別人）：${formatMoney(iOwe, base, { decimals: 0 })}`,
    ...rows.slice(0, 5).map(([pid, byCur]) => {
      const name = pmap.get(pid)?.name ?? '未知對象';
      const parts = [...byCur.entries()].filter(([, v]) => v !== 0).map(([cur, v]) => (v > 0 ? `欠你 ${formatMoney(v, cur, { decimals: 0 })}` : `你欠他 ${formatMoney(-v, cur, { decimals: 0 })}`));
      return `・${name}：${parts.join('、')}`;
    }),
  ];
  if (rows.length > 5) lines.push(`…還有 ${rows.length - 5} 位對象`);
  return { text: lines.join('\n'), sub: '還款時可在「計畫 → 應收／應付」點擊結清', link: { label: '前往應收／應付', to: '/plan?tab=debt' } };
}

const PROJECT_WORDS = /專案|旅行記帳|活動記帳/;

/** 專案對話：查詢進行中專案花費、預算與達成率 */
export async function projectTalk(text: string): Promise<LocalAnswer | null> {
  const t = text.trim();
  if (t.length > 40) return null;
  const projects = (await db.projects.toArray()).filter((p) => !p.deletedAt);
  const active = projects.filter((p) => p.status === 'active');

  // 指名特定專案名稱（例如「日本旅遊花了多少」）
  const hit = active.find((p) => t.includes(p.name));
  if (hit && (PROJECT_WORDS.test(t) || /(花|花了|支出|進度|預算|狀況|多少)/.test(t))) {
    const stats = await projectStats(hit);
    const pct = hit.budgetMinor ? Math.round((stats.expense / hit.budgetMinor) * 100) : null;
    const parts = [`專案「${hit.name}」已支出 ${formatMoney(stats.expense, hit.currency, { decimals: 0 })}`];
    if (hit.budgetMinor) {
      parts.push(`預算 ${formatMoney(hit.budgetMinor, hit.currency, { decimals: 0 })}（已用 ${pct}%，剩餘 ${formatMoney(Math.max(0, hit.budgetMinor - stats.expense), hit.currency, { decimals: 0 })}）`);
    }
    return { text: parts.join(' / '), link: { label: '查看專案明細', to: `/plan/projects/${hit.id}` } };
  }

  if (!PROJECT_WORDS.test(t) || !/(花|花了|支出|進度|預算|狀況|多少|有哪些|清單)/.test(t)) return null;
  if (!active.length) {
    return { text: '目前沒有進行中的專案。你可以建立「日本旅行」「婚禮」「裝潢」等專案獨立統計花費。', link: { label: '前往專案', to: '/plan?tab=project' } };
  }

  const rows = await Promise.all(active.slice(0, 4).map(async (p) => {
    const stats = await projectStats(p);
    const budget = p.budgetMinor ? ` / 預算 ${formatMoney(p.budgetMinor, p.currency, { decimals: 0 })}` : '';
    return `・${p.name}：已支出 ${formatMoney(stats.expense, p.currency, { decimals: 0 })}${budget}`;
  }));
  return { text: [`進行中的專案（共 ${active.length} 個）：`, ...rows].join('\n'), link: { label: '前往專案', to: '/plan?tab=project' } };
}

const GOAL_WORDS = /(存錢)?目標|存了多少|存錢進度|存了多少錢/;

/** 存錢目標對話：查詢各目標已存金額、目標金額與達成率 */
export async function goalTalk(text: string): Promise<LocalAnswer | null> {
  const t = text.trim();
  if (t.length > 40 || !GOAL_WORDS.test(t)) return null;
  const goals = (await db.goals.toArray()).filter((g) => !g.deletedAt && g.status === 'active');

  if (!goals.length) {
    return { text: '目前沒有進行中的存錢目標。直接說「幫我設一個年底前存 5 萬去日本玩的目標」即可建立！', link: { label: '前往存錢目標', to: '/plan?tab=goal' } };
  }

  const rows = await Promise.all(goals.slice(0, 4).map(async (g) => {
    const saved = await goalSaved(g);
    const pct = Math.round((saved / g.targetMinor) * 100);
    const deadline = g.deadline ? `（目標日：${g.deadline.replace(/-/g, '/')}）` : '';
    return `・${g.name}：已存 ${formatMoney(saved, g.currency, { decimals: 0 })} / ${formatMoney(g.targetMinor, g.currency, { decimals: 0 })}（${pct}%）${deadline}`;
  }));
  return { text: [`進行中的存錢目標（共 ${goals.length} 個）：`, ...rows].join('\n'), link: { label: '前往存錢目標', to: '/plan?tab=goal' } };
}

const RECURRING_WORDS = /(每(個)?月|每月)?(固定(支出|扣款|開銷)|訂閱).*(多少|清單|有哪些|總共)|每個月扣多少/;

/** 定期與訂閱對話：查詢每月固定支出與訂閱總額 */
export async function recurringTalk(text: string): Promise<LocalAnswer | null> {
  const t = text.trim();
  if (t.length > 40 || !RECURRING_WORDS.test(t)) return null;
  const rules = (await db.recurring_rules.toArray()).filter((r) => r.active && !r.deletedAt);
  const base = useSettings.getState().baseCurrency;

  let subTotal = 0;
  let otherTotal = 0;
  const subs: { name: string; monthly: number; cur: string }[] = [];

  for (const r of rules) {
    if (r.template.type !== 'expense') continue;
    const minor = r.template.baseAmountMinor ?? r.template.amountMinor ?? 0;
    const cur = r.template.currency ?? base;
    const monthly = Math.round((minor * timesPerYear(r.rule)) / 12);
    if (r.kind === 'subscription') {
      subTotal += cur === base ? monthly : 0;
      subs.push({ name: r.template.note || '訂閱項目', monthly, cur });
    } else {
      otherTotal += cur === base ? monthly : 0;
    }
  }

  const total = subTotal + otherTotal;
  if (!rules.length || total === 0) {
    return { text: '你目前沒有設定任何固定扣款或訂閱項目。說「建立每月 12 號 Netflix 390 的訂閱」即可自動追蹤。', link: { label: '前往定期與訂閱', to: '/plan?tab=recurring' } };
  }

  const lines = [
    `每月固定支出合計：約 ${formatMoney(total, base, { decimals: 0 })}／月（訂閱 ${formatMoney(subTotal, base, { decimals: 0 })}、其他固定扣款 ${formatMoney(otherTotal, base, { decimals: 0 })}）`,
    ...subs.slice(0, 5).map((s) => `・${s.name}：${formatMoney(s.monthly, s.cur, { decimals: 0 })}／月`),
  ];
  if (subs.length > 5) lines.push(`…還有 ${subs.length - 5} 個訂閱`);
  return { text: lines.join('\n'), link: { label: '前往定期與訂閱', to: '/plan?tab=recurring' } };
}

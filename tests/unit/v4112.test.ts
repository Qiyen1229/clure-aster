/**
 * v4.1.12：排程可選「到時直接記」、改／刪帳目（操作助手）、追問與比較、帳戶與預算本機問答、對話上下文
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction } from '@/db/repo/ledger';
import { processRecurring, saveBudget } from '@/db/repo/plan';
import { localEditPlan, looksLikeOperation } from '@/domain/agent/intent';
import { addDays, todayKey } from '@/domain/period';
import { applyPlan, loadAgentData, previewPlan, undoOp } from '@/services/agent';
import { ask, followUp } from '@/services/nlquery';
import { accountTalk, budgetTalk } from '@/services/localTalk';
import { resolveDraft, scheduleDrafts } from '@/services/quickentry';
import { chatHistory } from '@/features/home/AiChat';
import type { Msg } from '@/features/home/aiChatStore';

let acc = '';
let credit = '';
const add = (over: Partial<Parameters<typeof addTransaction>[0]> = {}) => addTransaction({
  type: 'expense', accountId: acc, categoryId: 'exp-food-lunch', amountMinor: 15000, currency: 'TWD', date: todayKey(), ts: Date.now(), note: '便當', ...over,
});
const balance = async (id: string) => (await db.accounts.get(id))!.balanceMinor;

beforeEach(async () => {
  await db.delete(); await db.open();
  await db.categories.bulkAdd(buildDefaultCategories());
  acc = (await addAccount({ name: '錢包', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 1_000_000, includeInNetWorth: true, isLiability: false })).id;
  credit = (await addAccount({ name: '中國信託', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 2_345_600, includeInNetWorth: true, isLiability: false })).id;
});

describe('排程：到時直接記', () => {
  it('★ auto：到期那天 App 直接入帳（不進收件匣），而且規則結束', async () => {
    const day = addDays(todayKey(), -1);
    const [rid] = await scheduleDrafts([await resolveDraft({ kind: 'expense', amount: 200, date: day, dateGiven: true, note: '午餐', raw: '', categoryId: 'exp-food-lunch' }, acc)], { auto: true });
    expect((await db.recurring_rules.get(rid))!.mode).toBe('auto');
    const before = await balance(acc);
    await processRecurring(todayKey());
    expect(await db.transactions.count()).toBe(1);
    expect(await balance(acc)).toBe(before - 20000);
    const r = (await db.recurring_rules.get(rid))!;
    expect(r.active).toBe(0);
    expect(r.pendingDates).toEqual([]);
  });
  it('★ 排了時間：當天還沒到那個時間就先不入帳（自動與確認都一樣）', async () => {
    const [rid] = await scheduleDrafts([await resolveDraft({ kind: 'expense', amount: 200, date: todayKey(), dateGiven: true, time: '23:59', note: '午餐', raw: '', categoryId: 'exp-food-lunch' }, acc)], { auto: true });
    await processRecurring(todayKey());
    if (new Date().toTimeString().slice(0, 5) < '23:59') {
      expect(await db.transactions.count()).toBe(0);
      expect((await db.recurring_rules.get(rid))!.active).toBe(1);
    }
  });
});

describe('操作助手：改與刪帳目', () => {
  it('★ 刪掉剛剛那筆（最近建立的）→ 預覽 → 執行 → 餘額退回 → 一鍵還原', async () => {
    await add({ note: '舊的' });
    const newest = await add({ note: '剛剛這筆', amountMinor: 30000, date: addDays(todayKey(), -3) }); // 補記舊日期，但是最近建立的
    const before = await balance(acc);
    const steps = await previewPlan([{ tool: 'delete_transaction', args: { match: { latest: true } } }]);
    expect(steps[0].preview.blocked).toBeUndefined();
    expect(steps[0].preview.affectedTx).toBe(1);
    expect(steps[0].preview.title).toContain('剛剛這筆');
    const log = await applyPlan(steps, '刪除剛剛那筆');
    expect((await db.transactions.get(newest.id))!.deletedAt).toBeTruthy();
    expect(await balance(acc)).toBe(before + 30000);
    await undoOp(log.id);
    expect((await db.transactions.get(newest.id))!.deletedAt).toBeFalsy();
    expect(await balance(acc)).toBe(before);
  });

  it('★ 改金額：指到一筆才能改；符合多筆就擋下；改完餘額跟著變、可還原', async () => {
    const t = await add({ note: '午餐A', amountMinor: 15000 });
    await add({ note: '午餐B', amountMinor: 18000 });
    const many = await previewPlan([{ tool: 'edit_transaction', args: { match: { keywords: ['午餐'] }, set: { amount: 200 } } }]);
    expect(many[0].preview.blocked).toContain('2 筆');
    const before = await balance(acc);
    const one = await previewPlan([{ tool: 'edit_transaction', args: { match: { keywords: ['午餐A'] }, set: { amount: 200 } } }]);
    expect(one[0].preview.blocked).toBeUndefined();
    const log = await applyPlan(one, '改金額');
    expect((await db.transactions.get(t.id))!.amountMinor).toBe(20000);
    expect(await balance(acc)).toBe(before - 5000);
    await undoOp(log.id);
    expect((await db.transactions.get(t.id))!.amountMinor).toBe(15000);
    expect(await balance(acc)).toBe(before);
  });

  it('只改分類或備註可以一次改多筆；分類不存在會擋下；刪除一次最多 20 筆', async () => {
    for (let i = 0; i < 3; i++) await add({ note: '星巴克' });
    const cat = await previewPlan([{ tool: 'edit_transaction', args: { match: { keywords: ['星巴克'] }, set: { category: '飲料' } } }]);
    expect(cat[0].preview.blocked).toBeUndefined();
    expect(cat[0].preview.affectedTx).toBe(3);
    const bad = await previewPlan([{ tool: 'edit_transaction', args: { match: { keywords: ['星巴克'] }, set: { category: '不存在的分類' } } }]);
    expect(bad[0].preview.blocked).toContain('找不到');
    for (let i = 0; i < 20; i++) await add({ note: '大量' });
    const del = await previewPlan([{ tool: 'delete_transaction', args: { match: { keywords: ['大量'] } } }]);
    expect(del[0].preview.blocked).toBeUndefined();
    await add({ note: '大量' });
    const over = await previewPlan([{ tool: 'delete_transaction', args: { match: { keywords: ['大量'] } } }]);
    expect(over[0].preview.blocked).toContain('最多刪 20 筆');
  });

  it('沒有任何條件不能刪或改；轉帳與股票帳目不會被當成候選', async () => {
    expect((await previewPlan([{ tool: 'delete_transaction', args: { match: {} } }]))[0].preview.blocked).toContain('沒有任何篩選條件');
    expect((await previewPlan([{ tool: 'edit_transaction', args: { match: { keywords: ['x'] }, set: {} } }]))[0].preview.blocked).toBeTruthy();
    const data = await loadAgentData();
    expect(data.txs.every((t) => !t.transferId)).toBe(true);
  });
});

describe('本機看得懂的修改／刪除與意圖', () => {
  it.each([
    ['刪掉剛剛那筆', 'delete_transaction', undefined],
    ['把剛剛那筆刪掉', 'delete_transaction', undefined],
    ['刪除上一筆', 'delete_transaction', undefined],
    ['剛剛那筆改成 180', 'edit_transaction', { amount: 180 }],
    ['剛剛那筆金額改成 200', 'edit_transaction', { amount: 200 }],
    ['剛剛那筆備註改成全聯', 'edit_transaction', { note: '全聯' }],
    ['剛剛那筆分類改成飲料', 'edit_transaction', { category: '飲料' }],
    ['上一筆改成交通', 'edit_transaction', { category: '交通' }],
  ])('%s', (t, tool, set) => {
    const p = localEditPlan(t)!;
    expect(p.steps[0].tool).toBe(tool);
    expect(p.steps[0].args.match).toEqual({ latest: true });
    if (set) expect(p.steps[0].args.set).toEqual(set);
  });
  it.each(['午餐 120', '今天花多少', '刪除帳號', '你好'])('不是修改／刪除：%s', (t) => { expect(localEditPlan(t)).toBeNull(); });
  it.each(['把昨天的午餐刪掉', '刪除昨天那筆消費', '把午餐的金額改成 150', '那筆其實是 250'])('交給 AI 規劃：%s', (t) => { expect(looksLikeOperation(t)).toBe(true); });
  it.each(['午餐 120', '我要怎麼刪除帳號', '你好', '這個月花多少'])('不誤判成操作：%s', (t) => { expect(looksLikeOperation(t)).toBe(false); });
});

describe('查帳追問與比較', () => {
  beforeEach(async () => {
    const t = todayKey();
    await add({ note: '午餐', amountMinor: 10000, date: t });
    await add({ note: '午餐', amountMinor: 5000, date: addDays(t, -40) });
    await add({ note: '捷運', categoryId: 'exp-transport', amountMinor: 3000, date: t });
  });
  it('★ 「那上個月呢」沿用上一個條件、只換期間', async () => {
    const a = (await ask('這個月吃飯花多少'))!;
    expect(a.query.rangeLabel).toBe('這個月');
    const f = (await followUp('那上個月呢', a.query))!;
    expect(f.fu.query.rangeLabel).toBe('上個月');
    expect(f.fu.query.categoryIds).toEqual(a.query.categoryIds);
    expect(f.answer.answer).toContain('上個月');
  });
  it('★ 「跟上個月比」輸出兩期總額與差額，並列出變動最多的分類', async () => {
    const a = (await ask('這個月花多少'))!;
    const f = (await followUp('跟上個月比呢', a.query))!;
    expect(f.fu.compare).toBe(true);
    expect(f.answer.answer).toMatch(/這個月支出 .*上個月 .*(多|少)了|一樣多/);
  });
  it('「只看中國信託」換帳戶、「換成捷運」換分類；不像追問的句子回傳 null', async () => {
    const a = (await ask('這個月花多少'))!;
    expect((await followUp('只看中國信託', a.query))!.fu.query.accountIds).toEqual([credit]);
    expect((await followUp('換成交通', a.query))!.fu.query.categoryLabel).toBe('交通');
    expect(await followUp('今天天氣如何', a.query)).toBeNull();
    expect(await followUp('午餐 120', a.query)).toBeNull();
  });
});

describe('帳戶與預算：本機回答', () => {
  it('★ 指名帳戶回餘額；問總共／淨資產列出各帳戶；有花費字眼的不處理', async () => {
    const one = (await accountTalk('我的中國信託有多少錢'))!;
    expect(one.text).toContain('中國信託');
    expect(one.text).toContain('23,456');
    const all = (await accountTalk('我總共有多少錢'))!;
    expect(all.text).toContain('淨資產');
    expect(all.text).toContain('錢包');
    expect(await accountTalk('中國信託這個月花多少')).toBeNull();
    expect(await accountTalk('你好')).toBeNull();
  });
  it('★ 預算：沒設定會教怎麼設；有設定回剩餘、今日還可花、預估', async () => {
    const none = (await budgetTalk('我這個月預算還剩多少'))!;
    expect(none.text).toContain('還沒有設定');
    await saveBudget({ name: '總預算', categoryId: '', amountMinor: 3_000_000, currency: 'TWD', period: 'month', rollover: false, alertPercents: [80], active: 1, startDate: todayKey() } as never);
    await add({ amountMinor: 100000 });
    const r = (await budgetTalk('我這個月還能花多少'))!;
    expect(r.text).toContain('總預算');
    expect(r.text).toContain('今天還可以花');
    expect(await budgetTalk('設飲食每月預算 8000')).toBeNull(); // 要改預算是操作，不在這裡處理
  });
});

describe('對話上下文', () => {
  it('只取文字訊息、最近 8 句、每句最多 400 字；記帳卡與思考中不算', () => {
    const msgs: Msg[] = [];
    for (let i = 0; i < 6; i++) { msgs.push({ id: i * 3, role: 'user', text: `問${i}` }, { id: i * 3 + 1, role: 'ai', kind: 'text', text: `答${i}${'x'.repeat(500)}` }, { id: i * 3 + 2, role: 'ai', kind: 'pending' }); }
    const h = chatHistory(msgs);
    expect(h).toHaveLength(8);
    expect(h.at(-1)).toMatchObject({ role: 'ai' });
    expect(h.every((x) => x.text.length <= 400)).toBe(true);
    expect(chatHistory([{ id: 1, role: 'ai', kind: 'text', text: '串流中', streaming: true }])).toEqual([]);
  });
});

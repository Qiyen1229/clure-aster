// @vitest-environment jsdom
/**
 * v4.1.36：旅遊模式隔離一致性。
 * 記帳入口（語音／收件匣共用的 bookDrafts）預設帶入旅遊專案與幣別；
 * 全域搜尋與問句查詢只算這次旅程的帳目。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import type { Account, Project, Transaction, Transfer } from '@/db/types';
import { useSettings } from '@/stores/settings';
import { bookDrafts, travelDraftDefaults, type ResolvedDraft } from '@/services/quickentry';
import { searchLedger } from '@/services/search';
import { answerQuestion } from '@/services/nlquery';
import { parseSearch } from '@/domain/search';
import type { NlQuery } from '@/domain/nlquery';
import { todayKey } from '@/domain/period';

const today = todayKey();
const TRAVEL = 'proj-okinawa';

const project = (over: Partial<Project> = {}): Project => ({
  id: TRAVEL, createdAt: 0, updatedAt: 0, name: '沖繩之旅', icon: '🏝️', color: '#0e9aa7',
  start: today, currency: 'JPY', status: 'active', isTravel: true, ...over,
});

const account = (id: string, currency = 'TWD'): Account => ({
  id, createdAt: 0, updatedAt: 0, name: id, icon: '💳', color: '#888888', type: 'cash',
  currency, initialBalanceMinor: 0, balanceMinor: 0, includeInNetWorth: true, isLiability: false, sort: 0, archived: 0,
});

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id, createdAt: 0, updatedAt: 0, type: 'expense', accountId: 'a1', categoryId: 'exp-food',
  amountMinor: 1000, currency: 'JPY', accountAmountMinor: 21000, baseAmountMinor: 21000,
  date: today, ts: 0, note: '拉麵', tagIds: [], attachmentIds: [], ...over,
});

const transfer = (id: string, over: Partial<Transfer> = {}): Transfer => ({
  id, createdAt: 0, updatedAt: 0, fromAccountId: 'a1', toAccountId: 'a2',
  fromAmountMinor: 10000, toAmountMinor: 10000, feeMinor: 0, date: today, ts: 0, note: '換匯', tagIds: [], ...over,
});

const draft = (over: Partial<ResolvedDraft> = {}): ResolvedDraft => ({
  kind: 'expense', amount: 150, date: today, dateGiven: false, accountId: 'a1', categoryId: 'exp-food',
  note: '拉麵', raw: '拉麵 150', tagIds: [], categorySource: 'default', accountSource: 'default', ...over,
});

const ctx = { cats: new Map(), accounts: new Map(), tags: new Map(), baseCurrency: 'TWD' };
const search = (text: string) => searchLedger(parseSearch(text, { today, weekStart: 0 }), ctx);

beforeEach(async () => {
  await Promise.all([db.transactions.clear(), db.transfers.clear(), db.accounts.clear(), db.projects.clear(), db.settings.clear(), db.meta.clear(), db.exchange_rates.clear()]);
  useSettings.setState({ travelModeProjectId: null, baseCurrency: 'TWD' });
  // 匯率設為新鮮並手動給 JPY→TWD，避免測試打網路
  await db.meta.put({ key: 'fxUpdatedAt', value: Date.now() });
  await db.exchange_rates.put({ base: 'JPY', quote: 'TWD', rateDec: '0.21', source: 'manual', updatedAt: Date.now() });
  await db.accounts.bulkAdd([account('a1'), account('a2')]);
});

describe('travelDraftDefaults：旅遊模式記帳預設', () => {
  it('沒有旅遊模式＝不帶專案、用帳戶幣別', () => {
    expect(travelDraftDefaults({}, undefined, 'TWD', 'TWD')).toEqual({ projectId: undefined, currency: 'TWD' });
  });
  it('旅遊中：預設歸入旅遊專案、用專案幣別（與記帳面板一致）', () => {
    expect(travelDraftDefaults({}, project(), 'TWD', 'TWD')).toEqual({ projectId: TRAVEL, currency: 'JPY' });
  });
  it('專案幣別等於主幣別時維持帳戶幣別', () => {
    expect(travelDraftDefaults({}, project({ currency: 'TWD' }), 'USD', 'TWD')).toEqual({ projectId: TRAVEL, currency: 'USD' });
  });
  it('草稿明寫的專案與幣別優先', () => {
    expect(travelDraftDefaults({ projectId: 'proj-other', currency: 'USD' }, project(), 'TWD', 'TWD'))
      .toEqual({ projectId: 'proj-other', currency: 'USD' });
  });
});

describe('bookDrafts：語音／收件匣入帳帶入旅遊專案', () => {
  it('旅遊模式：沒寫專案的草稿歸入旅遊專案、以專案幣別記', async () => {
    await db.projects.add(project());
    useSettings.setState({ travelModeProjectId: TRAVEL });
    const { txIds } = await bookDrafts([draft()]);
    const saved = await db.transactions.get(txIds[0]);
    expect(saved?.projectId).toBe(TRAVEL);
    expect(saved?.currency).toBe('JPY');
    expect(saved?.amountMinor).toBe(150);
    expect(saved?.accountAmountMinor).toBe(3150); // 150 JPY × 0.21 = 31.5 TWD → 3150 分
  });
  it('一般模式：不帶專案、用帳戶幣別', async () => {
    const { txIds } = await bookDrafts([draft()]);
    const saved = await db.transactions.get(txIds[0]);
    expect(saved?.projectId).toBeUndefined();
    expect(saved?.currency).toBe('TWD');
  });
  it('旅遊模式但草稿已寫其他專案：照草稿', async () => {
    await db.projects.add(project());
    useSettings.setState({ travelModeProjectId: TRAVEL });
    const { txIds } = await bookDrafts([draft({ projectId: 'proj-other', currency: 'TWD' })]);
    const saved = await db.transactions.get(txIds[0]);
    expect(saved?.projectId).toBe('proj-other');
    expect(saved?.currency).toBe('TWD');
  });
});

describe('searchLedger：旅遊模式只搜得到這次旅程', () => {
  beforeEach(async () => {
    await db.projects.add(project());
    await db.transactions.bulkAdd([
      tx('tx-travel', { projectId: TRAVEL }),
      tx('tx-home'),
      tx('tx-other', { projectId: 'proj-other' }),
    ]);
    await db.transfers.bulkAdd([
      transfer('tr-travel', { projectId: TRAVEL }),
      transfer('tr-home'),
    ]);
  });
  it('旅遊模式：只回傳旅遊專案的帳目與有標專案的轉帳', async () => {
    useSettings.setState({ travelModeProjectId: TRAVEL });
    expect((await search('拉麵')).items.map((i) => i.id)).toEqual(['tx-travel']);
    expect((await search('換匯')).items.map((i) => i.id)).toEqual(['tr-travel']);
  });
  it('一般模式：全部搜得到', async () => {
    expect((await search('拉麵')).items.map((i) => i.id).sort()).toEqual(['tx-home', 'tx-other', 'tx-travel']);
    expect((await search('換匯')).items.map((i) => i.id).sort()).toEqual(['tr-home', 'tr-travel']);
  });
});

describe('answerQuestion：旅遊模式的問句統計只算旅程帳目', () => {
  const q = (): NlQuery => ({
    range: { start: `${today.slice(0, 8)}01`, end: today }, rangeLabel: '本月',
    prevRange: { start: '2000-01-01', end: '2000-01-31' }, prevLabel: '上期',
    kind: 'expense', categoryIds: [], accountIds: [], metric: 'sum',
  });
  beforeEach(async () => {
    await db.projects.add(project());
    await db.transactions.bulkAdd([
      tx('tx-travel', { projectId: TRAVEL }),
      tx('tx-home', { baseAmountMinor: 50000, currency: 'TWD', amountMinor: 50000, accountAmountMinor: 50000 }),
    ]);
  });
  it('旅遊模式：只算旅遊專案的支出', async () => {
    useSettings.setState({ travelModeProjectId: TRAVEL });
    const a = await answerQuestion(q());
    expect(a.items.map((t) => t.id)).toEqual(['tx-travel']);
    expect(a.answer).toContain('210');
    expect(a.answer).not.toContain('710');
  });
  it('一般模式：全部計入', async () => {
    const a = await answerQuestion(q());
    expect(a.items).toHaveLength(2);
    expect(a.answer).toContain('710');
  });
});
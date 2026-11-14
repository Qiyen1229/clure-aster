import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addDurable } from '@/db/repo/durables';
import { addDebts, findOrCreatePerson, saveGoal, saveProject } from '@/db/repo/plan';
import { accountTalk, debtTalk, durableTalk, goalTalk, projectTalk, recurringTalk } from '@/services/localTalk';
import { respond } from '@/features/home/AiChat';
import { todayKey } from '@/domain/period';

describe('Cilo 本機問答兼容性 (localTalk)', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
  });

  describe('durableTalk 耐用品問答', () => {
    it('無耐用品時友善提示', async () => {
      const res = await durableTalk('我有幾件耐用品');
      expect(res).not.toBeNull();
      expect(res?.text).toContain('目前沒有正在追蹤的耐用品');
      expect(res?.link?.to).toBe('/plan?tab=durable');
    });

    it('有耐用品時統計件數與每日分攤合計', async () => {
      await addDurable({ name: 'iPhone 16 Pro', icon: '📱', purchaseDate: '2025-01-01', costMinor: 36900_00, currency: 'TWD', lifeYears: 3 });
      await addDurable({ name: 'MacBook Air', icon: '💻', purchaseDate: '2025-01-01', costMinor: 35900_00, currency: 'TWD', lifeYears: 4 });

      const res = await durableTalk('耐用品每天多少錢');
      expect(res).not.toBeNull();
      expect(res?.text).toContain('2 件耐用品');
      expect(res?.text).toContain('iPhone 16 Pro');
      expect(res?.text).toContain('MacBook Air');
      expect(res?.link?.to).toBe('/plan?tab=durable');
    });

    it('指名特定耐用品時精確回答該物品使用天數與每日成本', async () => {
      await addDurable({ name: 'iPhone 16 Pro', icon: '📱', purchaseDate: '2025-01-01', costMinor: 36900_00, currency: 'TWD', lifeYears: 3 });

      const res = await durableTalk('iPhone 16 Pro 每天多少錢');
      expect(res).not.toBeNull();
      expect(res?.text).toContain('「iPhone 16 Pro」已使用');
      expect(res?.text).toContain('平均每天持有成本');
      expect(res?.link?.to).toBe('/plan?tab=durable');
    });
  });

  describe('debtTalk 應收／應付借貸問答', () => {
    it('無未結借貸時提示無款項', async () => {
      const res = await debtTalk('誰欠我錢');
      expect(res).not.toBeNull();
      expect(res?.text).toContain('目前沒有任何未結清的借貸');
    });

    it('有借貸時列出應收與應付總額及對象', async () => {
      const p1 = await findOrCreatePerson('小明');
      const p2 = await findOrCreatePerson('大華');
      await addDebts([
        { personId: p1.id, direction: 'they_owe_me', amountMinor: 1500_00, currency: 'TWD', date: todayKey(), note: '聚餐代墊' },
        { personId: p2.id, direction: 'i_owe_them', amountMinor: 600_00, currency: 'TWD', date: todayKey(), note: '買電影票' },
      ]);

      const res = await debtTalk('誰欠我錢');
      expect(res).not.toBeNull();
      expect(res?.text).toContain('應收（別人欠我）');
      expect(res?.text).toContain('小明');
      expect(res?.text).toContain('欠你 $1,500');
      expect(res?.link?.to).toBe('/plan?tab=debt');
    });

    it('詢問特定對象的欠款金額', async () => {
      const p = await findOrCreatePerson('小明');
      await addDebts([{ personId: p.id, direction: 'they_owe_me', amountMinor: 2000_00, currency: 'TWD', date: todayKey(), note: '借出' }]);

      const res = await debtTalk('小明欠我多少');
      expect(res).not.toBeNull();
      expect(res?.text).toContain('小明：欠你 $2,000');
    });
  });

  describe('projectTalk 專案問答', () => {
    it('無進行中專案時提示', async () => {
      const res = await projectTalk('有哪些專案');
      expect(res).not.toBeNull();
      expect(res?.text).toContain('目前沒有進行中的專案');
    });

    it('有專案時列出專案花費與預算', async () => {
      await saveProject({
        name: '日本跨年',
        icon: 'plane',
        color: '#ff6600',
        start: '2025-12-25',
        currency: 'TWD',
        budgetMinor: 50000_00,
        status: 'active',
      });

      const res = await projectTalk('日本跨年花了多少');
      expect(res).not.toBeNull();
      expect(res?.text).toContain('專案「日本跨年」已支出');
      expect(res?.text).toContain('預算 $50,000');
    });
  });

  describe('goalTalk 存錢目標問答', () => {
    it('查詢進行中存錢目標進度', async () => {
      await saveGoal({
        name: '買機車',
        icon: '🛵',
        color: '#3388ff',
        start: '2025-01-01',
        currency: 'TWD',
        targetMinor: 80000_00,
        status: 'active',
        linkedAccountIds: [],
        manualSavedMinor: 30000_00,
      });

      const res = await goalTalk('存錢目標進度');
      expect(res).not.toBeNull();
      expect(res?.text).toContain('買機車');
      expect(res?.text).toContain('$30,000 / $80,000');
      expect(res?.link?.to).toBe('/plan?tab=goal');
    });
  });

  describe('accountTalk 負債查詢加強', () => {
    it('查詢負債與信用卡欠款總額', async () => {
      await addAccount({ name: '國泰信用卡', icon: '', color: '', type: 'credit', currency: 'TWD', initialBalanceMinor: -15000_00, includeInNetWorth: true, isLiability: true });
      await addAccount({ name: '玉山信貸', icon: '', color: '', type: 'loan', currency: 'TWD', initialBalanceMinor: -200000_00, includeInNetWorth: true, isLiability: true });

      const res = await accountTalk('我負債多少');
      expect(res).not.toBeNull();
      expect(res?.text).toContain('負債總額');
      expect(res?.text).toContain('國泰信用卡：欠 $15,000');
      expect(res?.text).toContain('玉山信貸：欠 $200,000');
      expect(res?.link?.to).toBe('/accounts');
    });
  });

  describe('recurringTalk 每月固定扣款與訂閱', () => {
    it('統計每月固定支出與訂閱', async () => {
      await db.recurring_rules.add({
        id: 'rec-1',
        name: 'Netflix',
        rule: { freq: 'month', interval: 1, byMonthDay: 10 },
        template: { type: 'expense', amountMinor: 390_00, currency: 'TWD', accountId: 'acc-1', categoryId: 'exp-ent', note: 'Netflix' },
        active: 1,
        mode: 'auto',
        startDate: '2025-01-01',
        nextDue: '2025-02-10',
        doneCount: 0,
        pendingDates: [],
        remindDaysBefore: 1,
        kind: 'subscription',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const res = await recurringTalk('每個月固定扣款多少');
      expect(res).not.toBeNull();
      expect(res?.text).toContain('每月固定支出合計');
      expect(res?.text).toContain('Netflix');
      expect(res?.link?.to).toBe('/plan?tab=recurring');
    });
  });

  describe('對話框 respond() 整合測試', () => {
    it('問耐用品直接在對話框本機回答，不扣 AI 額度', async () => {
      await addDurable({ name: 'iPhone 16 Pro', icon: '📱', purchaseDate: '2025-01-01', costMinor: 36900_00, currency: 'TWD', lifeYears: 3 });
      const r = await respond('我有幾件耐用品');
      expect(r.kind).toBe('text');
      if (r.kind === 'text') {
        expect(r.text).toContain('1 件耐用品');
        expect(r.text).toContain('iPhone 16 Pro');
      }
    });

    it('問誰欠我錢直接在對話框本機回答', async () => {
      const p = await findOrCreatePerson('小王');
      await addDebts([{ personId: p.id, direction: 'they_owe_me', amountMinor: 500_00, currency: 'TWD', date: todayKey(), note: '飲料' }]);
      const r = await respond('誰欠我錢');
      expect(r.kind).toBe('text');
      if (r.kind === 'text') {
        expect(r.text).toContain('小王');
        expect(r.text).toContain('$500');
      }
    });
  });
});

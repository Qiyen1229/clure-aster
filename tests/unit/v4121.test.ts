import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { toCSV } from '@/services/csv';
import { normDate } from '@/services/importer';
import { addTransaction, updateTransaction } from '@/db/repo/ledger';
import { handle, ALLOWED_HOSTS } from '../../proxy/src/core';
import { bookInboxEntries } from '@/services/inbox';

describe('v4.1.21 安全性與穩定性修正驗證', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.accounts.clear();
  });

  describe('CSV 公式注入防護', () => {
    it('轉義 =, +, -, @, Tab 開頭的惡意公式，但保留合法數字', () => {
      const rows = [
        ['備註', '金額', '公式測試'],
        ['=cmd|\' /C calc\'!A0', -120.5, '+SUM(A1:A2)'],
        ['-2+3*cmd', 1500, '@evil_func()'],
        ['一般備註', 0, '正常文字'],
      ];
      const csv = toCSV(rows);
      expect(csv).toContain("'=cmd|' /C calc'!A0");
      expect(csv).toContain("'+SUM(A1:A2)");
      expect(csv).toContain("'-2+3*cmd");
      expect(csv).toContain("'@evil_func()");
      expect(csv).toContain(',-120.5,');
      expect(csv).toContain(',1500,');
    });
  });

  describe('匯入解析優化', () => {
    it('精準區分西元 2 位數年份與民國年', () => {
      expect(normDate('24/10/01')).toBe('2024-10-01');
      expect(normDate('24-05-20')).toBe('2024-05-20');
      expect(normDate('113/10/01')).toBe('2024-10-01');
      expect(normDate('民國113年10月1日')).toBe('2024-10-01');
      expect(normDate('民國24年10月1日')).toBe('1935-10-01');
    });
  });

  describe('軟刪帳目編輯餘額防護', () => {
    it('編輯已軟刪除的帳目時，不應重複加回或影響帳戶餘額', async () => {
      const acc = { id: 'acc-test', name: '測試帳戶', type: 'cash' as const, currency: 'TWD', balanceMinor: 100000, initialBalanceMinor: 100000, archived: 0 as const, sort: 1, icon: '💰', color: '#000', includeInNetWorth: true, isLiability: false, createdAt: Date.now(), updatedAt: Date.now() };
      await db.accounts.add(acc);

      const tx = await addTransaction({
        type: 'expense',
        accountId: 'acc-test',
        categoryId: 'cat-1',
        amountMinor: 20000,
        currency: 'TWD',
        date: '2026-11-10',
        ts: Date.now(),
      });
      let a = await db.accounts.get('acc-test');
      expect(a?.balanceMinor).toBe(80000);

      // 軟刪除
      await db.transactions.update(tx.id, { deletedAt: Date.now() });
      await db.accounts.update('acc-test', { balanceMinor: 100000 }); // 回復餘額

      // 編輯已刪除帳目
      await updateTransaction(tx.id, {
        type: 'expense',
        accountId: 'acc-test',
        categoryId: 'cat-1',
        amountMinor: 25000,
        currency: 'TWD',
        date: '2026-11-10',
        ts: Date.now(),
      });

      a = await db.accounts.get('acc-test');
      expect(a?.balanceMinor).toBe(100000); // 餘額不受已軟刪帳目修改影響
    });
  });

  describe('確定性 ID 冪等入帳防重複扣款', () => {
    it('使用確定性 ID 重複 addTransaction 不會產生兩筆資料或重複扣款', async () => {
      const acc = { id: 'acc-rec', name: '週期帳戶', type: 'cash' as const, currency: 'TWD', balanceMinor: 100000, initialBalanceMinor: 100000, archived: 0 as const, sort: 1, icon: '💰', color: '#000', includeInNetWorth: true, isLiability: false, createdAt: Date.now(), updatedAt: Date.now() };
      await db.accounts.add(acc);

      const input = {
        id: 'rec-sub1-2026-11-10',
        type: 'expense' as const,
        accountId: 'acc-rec',
        categoryId: 'cat-1',
        amountMinor: 5000,
        currency: 'TWD',
        date: '2026-11-10',
        ts: Date.now(),
        recurringRuleId: 'sub1',
      };

      // 模擬裝置 A 入帳
      await addTransaction(input);
      let a = await db.accounts.get('acc-rec');
      expect(a?.balanceMinor).toBe(95000);

      // 模擬裝置 B 同步或併發執行入帳
      await addTransaction(input);
      a = await db.accounts.get('acc-rec');
      expect(a?.balanceMinor).toBe(95000); // 餘額不被重複扣除

      const all = await db.transactions.toArray();
      expect(all.length).toBe(1);
    });
  });

  describe('收件匣自動入帳防遺失', () => {
    it('入帳失敗時不呼叫 ack，保留收件匣資料', async () => {
      const entry = {
        item: { id: 999, source: 'sms', payload: {}, raw_text: 'test' },
        drafts: [
          {
            kind: 'expense' as const,
            accountId: 'non-existing-acc',
            categoryId: 'cat-1',
            amountMinor: 1000,
            currency: 'TWD',
            date: '2026-11-10',
            note: '測試',
          },
        ],
      };

      const res = await bookInboxEntries([entry as any]);
      expect(res.count).toBe(0);
      expect(res.skipped).toBe(1);
    });
  });

  describe('股票代理安全防護', () => {
    it('將 text/html 上游回應轉為 text/plain 並加上 sandbox CSP 防同源 XSS', async () => {
      const orig = globalThis.fetch;
      const htmlRes = new Response('<html><script>alert(1)</script></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      globalThis.fetch = vi.fn().mockResolvedValueOnce(htmlRes);

      try {
        const req = new Request(`http://localhost/fetch?url=https://${ALLOWED_HOSTS[0]}/page`);
        const res = await handle(req, {});
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      } finally {
        globalThis.fetch = orig;
      }
    });

    it('錯誤回應（如 429 或 404）帶 no-store，禁止瀏覽器快取', async () => {
      const orig = globalThis.fetch;
      const errRes = new Response('too many requests', { status: 429, headers: {} });
      globalThis.fetch = vi.fn().mockResolvedValueOnce(errRes);

      try {
        const req = new Request(`http://localhost/fetch?url=https://${ALLOWED_HOSTS[0]}/ratelimit`);
        const res = await handle(req, {});
        expect(res.status).toBe(429);
        expect(res.headers.get('cache-control')).toContain('no-store');
      } finally {
        globalThis.fetch = orig;
      }
    });
  });
});

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { safeToMinor } from '@/domain/money';
import { DEFAULT_TW_FEES, twTaxRate } from '@/domain/invest/fees-tw';
import { findAmounts } from '@/domain/nlp-amount';
import { parseEntries } from '@/domain/nlp';
import { extractDate } from '@/domain/nlp-date';
import { looksLikeOperation } from '@/domain/agent/intent';
import { buildSankey, DEFAULT_ESSENTIAL_MAIN_IDS } from '@/domain/sankey';
import { forecastBudget } from '@/domain/budgetwarn';
import { marketState, usHolidays } from '@/domain/invest/market-hours';
import { RELEASE_NOTES } from '@/features/whatsnew/releaseNotes';
import type { Account, Transaction } from '@/db/types';

describe('v4.1.22 功能升級與安全性驗證', () => {
  describe('金額輸入安全防護', () => {
    it('safeToMinor 對多重小數點與非法格式安全回退，不拋出錯誤崩潰', () => {
      expect(safeToMinor('1.2.3', 'TWD')).toBe(0);
      expect(safeToMinor('abc', 'TWD', 100)).toBe(100);
      expect(safeToMinor('100.5', 'TWD')).toBe(10050);
      expect(safeToMinor('', 'TWD')).toBe(0);
    });
  });

  describe('台股現股當沖證交稅減半', () => {
    it('當沖交易證交稅率為 0.0015 (0.15%)，一般交易為 0.003 (0.3%)', () => {
      expect(twTaxRate('stock', DEFAULT_TW_FEES, undefined, true)).toBe('0.0015');
      expect(twTaxRate('stock', DEFAULT_TW_FEES, undefined, false)).toBe('0.003');
      expect(twTaxRate('stock')).toBe('0.003');
    });
  });

  describe('NLP 金額解析增強', () => {
    it('正確解析負數金額與包含負字的說法', () => {
      const hits1 = findAmounts('負五十元');
      expect(hits1.length).toBe(1);
      expect(hits1[0].value).toBe(-50);
      expect(hits1[0].negative).toBe(true);

      const hits2 = findAmounts('-100塊');
      expect(hits2.length).toBe(1);
      expect(hits2[0].value).toBe(-100);
      expect(hits2[0].negative).toBe(true);
    });

    it('一般 101 金額不再被台北 101 保護詞誤殺', () => {
      const hits1 = findAmounts('早餐101元');
      expect(hits1.length).toBe(1);
      expect(hits1[0].value).toBe(101);

      const hits2 = findAmounts('去台北101觀景台門票 600元');
      expect(hits2.length).toBe(1);
      expect(hits2[0].value).toBe(600);
    });

    it('多筆未標記與標記金額同時出現時（早餐100 午餐120元）不漏掉前者', () => {
      const res = parseEntries('早餐100 午餐120元', {
        today: '2026-11-10',
        accounts: [],
        categories: [],
      });
      expect(res.length).toBe(2);
      expect(res[0].amount).toBe(100);
      expect(res[1].amount).toBe(120);
    });

    it('輸入「不要記帳」時回傳空陣列，不誤入帳', () => {
      const res = parseEntries('不要記帳 早餐 100', {
        today: '2026-11-10',
        accounts: [],
        categories: [],
      });
      expect(res).toEqual([]);
    });
  });

  describe('NLP 日期解析增強', () => {
    const today = '2026-11-10';

    it('支援明年、後年、去年等相對年份', () => {
      expect(extractDate('明年1月5日出發', today).date).toBe('2027-01-05');
      expect(extractDate('後年3月20日去日本', today).date).toBe('2028-03-20');
      expect(extractDate('去年10月1日買的', today).date).toBe('2025-10-01');
    });

    it('支援裸「下個月」與「上個月」對應到鄰月同日', () => {
      expect(extractDate('下個月繳房租', today).date).toBe('2026-12-10');
      expect(extractDate('上個月買的', today).date).toBe('2026-10-10');
    });

    it('非合法日數（如 2 月 31 日）自動夾止至月底，不回傳 null', () => {
      expect(extractDate('31號', '2026-03-01').date).toBe('2026-02-28');
    });
  });

  describe('AI Agent 意圖否定詞守衛', () => {
    it('帶有否定前綴的整理與刪除要求不誤判為操作', () => {
      expect(looksLikeOperation('不要刪除剛剛那筆')).toBe(false);
      expect(looksLikeOperation('別刪除上一筆')).toBe(false);
      expect(looksLikeOperation('請勿修改分類')).toBe(false);
      expect(looksLikeOperation('暫不調整預算')).toBe(false);
      expect(looksLikeOperation('刪除剛剛那筆')).toBe(true);
    });
  });

  describe('Sankey 桑基圖流量守恆', () => {
    it('儲蓄流入帳戶總額必須嚴格等於 saving 總額', () => {
      const acc1 = { id: 'a1', name: '帳戶1', icon: '', color: '', type: 'bank', currency: 'TWD' } as unknown as Account;
      const acc2 = { id: 'a2', name: '帳戶2', icon: '', color: '', type: 'bank', currency: 'TWD' } as unknown as Account;
      const accounts = new Map([['a1', acc1], ['a2', acc2]]);
      const txs = [
        { id: 't1', type: 'income', categoryId: 'inc-salary', accountId: 'a1', amountMinor: 70000, baseAmountMinor: 70000, currency: 'TWD', date: '2026-11-10', ts: 1, tagIds: [] },
        { id: 't2', type: 'income', categoryId: 'inc-salary', accountId: 'a2', amountMinor: 30000, baseAmountMinor: 30000, currency: 'TWD', date: '2026-11-10', ts: 2, tagIds: [] },
        { id: 't3', type: 'expense', categoryId: 'exp-food', accountId: 'a1', amountMinor: 40000, baseAmountMinor: 40000, currency: 'TWD', date: '2026-11-10', ts: 3, tagIds: [] },
      ] as unknown as Transaction[];

      const m = buildSankey(txs, new Map(), accounts, { essentialMainIds: new Set(DEFAULT_ESSENTIAL_MAIN_IDS), depth: 'main' });
      expect(m.saving).toBe(60000);
      const toAcc = m.links.filter((l) => l.source === 'g:saving');
      const sumSavingLinks = toAcc.reduce((sum, l) => sum + l.value, 0);
      expect(sumSavingLinks).toBe(m.saving);
    });
  });

  describe('預算警告文案正確性', () => {
    it('當未超支且可撐至期末時，文案說明接近上限而非誤報結束前用完', () => {
      const warn = forecastBudget({
        id: 'b-1',
        name: '餐飲預算',
        limit: 10000,
        spent: 8800,
        projected: 9500,
        period: { start: '2026-11-01', end: '2026-11-30' },
        today: '2026-11-28',
      }, (m) => `$${m}`);
      expect(warn).not.toBeNull();
      expect(warn?.why).toContain('照目前速度雖然能撐到期末，但已接近額度上限');
      expect(warn?.why).not.toContain('這一期結束前會用完');
    });
  });

  describe('市場開休市時段精確判定', () => {
    it('港股 12:00～13:00 午休時段標記為 closed', () => {
      const lunchTime = new Date('2026-11-10T12:30:00+08:00');
      expect(marketState('HK', lunchTime)).toBe('closed');
    });

    it('次年 1/1 逢週六時，當年 12/31 補休納入美股休市', () => {
      const h2021 = usHolidays(2021);
      expect(h2021.has('2021-12-31')).toBe(true);
    });
  });

  describe('版本更新重點標題與結構檢驗', () => {
    it('v4.1.22 的各項更新重點標題維持在 10 字以內，簡潔俐落', () => {
      const v4122 = RELEASE_NOTES.find((n) => n.version === '4.1.22');
      expect(v4122).toBeDefined();
      expect(v4122!.features.length).toBeGreaterThanOrEqual(3);
      for (const f of v4122!.features) {
        expect(f.title.length).toBeLessThanOrEqual(10);
      }
    });
  });
});

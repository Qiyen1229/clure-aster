// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { cleanDecimalInput, FilterSheet } from '@/features/ledger/FilterSheet';
import type { TxFilter } from '@/db/types';
import { db } from '@/db/schema';
import { processPushNotification } from '@/services/pushDedupe';
import { notify } from '@/services/notifications';

describe('v4.1.23 Phase 1 測試', () => {
  describe('T4: FilterSheet 多小數點防護與狀態同步', () => {
    it('cleanDecimalInput 正常收斂多重小數點與排除非數字', () => {
      expect(cleanDecimalInput('1.2.3')).toBe('1.23');
      expect(cleanDecimalInput('100..50')).toBe('100.50');
      expect(cleanDecimalInput('abc12.34xyz')).toBe('12.34');
      expect(cleanDecimalInput('...')).toBe('.');
    });

    it('FilterSheet 連續輸入多小數點不拋錯且同步狀態', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      let currentFilter: TxFilter = {};
      const handleChange = (f: TxFilter) => {
        currentFilter = f;
      };

      await act(async () => {
        root.render(React.createElement(FilterSheet, { open: true, onClose: () => {}, value: currentFilter, onChange: handleChange }));
      });

      const minInput = document.body.querySelector<HTMLInputElement>('input[placeholder="最小"]');
      const maxInput = document.body.querySelector<HTMLInputElement>('input[placeholder="最大"]');
      expect(minInput).not.toBeNull();
      expect(maxInput).not.toBeNull();

      // 模擬使用者輸入 1.2.3
      await act(async () => {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        nativeSetter.call(minInput, '1.2.3');
        minInput!.dispatchEvent(new Event('input', { bubbles: true }));
        minInput!.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(minInput!.value).toBe('1.23');
      expect(currentFilter.minMinor).toBe(123);

      // 模擬套用常用篩選（外部傳入新 filter）
      await act(async () => {
        currentFilter = { minMinor: 50000, maxMinor: 100000 };
        root.render(React.createElement(FilterSheet, { open: true, onClose: () => {}, value: currentFilter, onChange: handleChange }));
      });

      expect(minInput!.value).toBe('500');
      expect(maxInput!.value).toBe('1000');

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });
  });
});

describe('v4.1.23 Phase 2 測試', () => {
  describe('T5: sw push 與本機排程重複通知去重', () => {
    it('本機已排程 + 伺服器 push 同一提醒只產生一次通知', async () => {
      await db.reminders.clear();

      // 1. 本機排程先觸發：寫入 reminders
      await db.reminders.put({
        id: 'daily:2026-11-10',
        kind: 'daily_log',
        refId: '/add',
        dueAt: Date.now(),
        done: 0,
        notifiedAt: Date.now(),
        title: '今天還沒記帳喔 ✍️',
        body: '花 10 秒記下今天的花費吧',
      });

      // 2. 伺服器 push 隨後送達同一 tag
      const notifySpy = vi.fn();
      const handled = await processPushNotification(
        { title: '今天還沒記帳喔 ✍️', body: '花 10 秒記下今天的花費吧', tag: 'daily:2026-11-10' },
        notifySpy,
      );

      // 由於本機已記錄，push 被去重跳過，不重複呼叫 showNotification
      expect(handled).toBe(false);
      expect(notifySpy).not.toHaveBeenCalled();

      // 3. 反向情境：伺服器 push 先到，本機提醒後到
      const handledNew = await processPushNotification(
        { title: '💳 信用卡繳款提醒', body: '本期應繳 1000', tag: 'card:acc1:2026-11-15' },
        notifySpy,
      );
      expect(handledNew).toBe(true);
      expect(notifySpy).toHaveBeenCalledTimes(1);

      // SW 已將其寫入本機 reminders
      expect(await db.reminders.get('card:acc1:2026-11-15')).toBeDefined();

      // 本機排程後續檢查到期時呼叫 notify()
      const regSpy = vi.fn();
      const origSW = navigator.serviceWorker;
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { ready: Promise.resolve({ showNotification: regSpy }) },
        configurable: true,
      });

      await notify('💳 信用卡繳款提醒', '本期應繳 1000', '/accounts/acc1', 'card_due', 'card:acc1:2026-11-15');
      // 本機 notify() 因 reminders 已存在該 id 而直接 return，不再重響
      expect(regSpy).not.toHaveBeenCalled();

      Object.defineProperty(navigator, 'serviceWorker', { value: origSW, configurable: true });
    });
  });
});

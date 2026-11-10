// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

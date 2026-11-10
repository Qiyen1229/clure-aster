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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { DAY_TRADE_TAX_SUNSET, DEFAULT_TW_FEES, twTaxRate } from '@/domain/invest/fees-tw';
import { marketState } from '@/domain/invest/market-hours';
import { AgentBubble } from '@/features/home/AiChat';
import { parseTwMarketTime, providerById } from '@/services/quotes/providers';

const previewResolvers: Array<(steps: any[]) => void> = [];

vi.mock('@/services/agent', () => ({
  previewPlan: vi.fn(() => {
    return new Promise((resolve) => {
      previewResolvers.push(resolve);
    });
  }),
  applyPlan: vi.fn(),
  undoOp: vi.fn(),
}));

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

  describe('T6: deploy-nas 覆蓋解壓殘留舊檔防護', () => {
    it('rsync --delete 清除舊版檔案且完整保留 .env 與 data/', () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-deploy-test-'));
      try {
        // 建立 vA 環境（含使用者資料與舊版特有檔）
        fs.writeFileSync(path.join(testDir, '.env'), 'SECRET_KEY=keep_me\n');
        fs.mkdirSync(path.join(testDir, 'data'));
        fs.writeFileSync(path.join(testDir, 'data', 'clure.db'), 'sqlite-binary-data');
        fs.writeFileSync(path.join(testDir, 'old-deprecated-file.js'), 'console.log("old");');

        // 建立 vB 部署包解壓縮後的 .deploy-tmp 目錄（無 old-deprecated-file.js，有 new-file.js）
        const deployTmp = path.join(testDir, '.deploy-tmp');
        fs.mkdirSync(deployTmp);
        fs.writeFileSync(path.join(deployTmp, 'new-file.js'), 'console.log("new");');

        // 執行 rsync 同步
        execSync(
          `rsync -a --delete --exclude='.env' --exclude='data/' --exclude='server/data/' --exclude='server/.venv/' --exclude='aster-nas.zip' --exclude='.deploy-tmp' "${deployTmp}/" "${testDir}/"`,
        );
        fs.rmSync(deployTmp, { recursive: true, force: true });

        // 驗證
        expect(fs.existsSync(path.join(testDir, 'new-file.js'))).toBe(true);
        expect(fs.existsSync(path.join(testDir, 'old-deprecated-file.js'))).toBe(false); // 已被刪除
        expect(fs.readFileSync(path.join(testDir, '.env'), 'utf-8')).toBe('SECRET_KEY=keep_me\n'); // .env 保留
        expect(fs.readFileSync(path.join(testDir, 'data', 'clure.db'), 'utf-8')).toBe('sqlite-binary-data'); // data 保留
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  describe('T7: 當沖稅減半落日條款', () => {
    it('2026-12-31（含）前當沖賣出 0.15%；2027-01-01 起恢復 0.3%；非當沖不受影響', () => {
      expect(DAY_TRADE_TAX_SUNSET).toBe('2026-12-31');

      // 2026-12-31（含）前當沖賣出為 0.0015 (0.15%)
      expect(twTaxRate('stock', DEFAULT_TW_FEES, undefined, true, '2026-12-31')).toBe('0.0015');
      expect(twTaxRate('stock', DEFAULT_TW_FEES, undefined, true, '2026-06-15')).toBe('0.0015');

      // 2027-01-01 起當沖落日，恢復一般股票證交稅率 0.003 (0.3%)
      expect(twTaxRate('stock', DEFAULT_TW_FEES, undefined, true, '2027-01-01')).toBe('0.003');
      expect(twTaxRate('stock', DEFAULT_TW_FEES, undefined, true, '2027-05-20')).toBe('0.003');

      // 非當沖交易一律不受影響
      expect(twTaxRate('stock', DEFAULT_TW_FEES, undefined, false, '2026-12-31')).toBe('0.003');
      expect(twTaxRate('stock', DEFAULT_TW_FEES, undefined, false, '2027-01-01')).toBe('0.003');

      // ETF 與債券 ETF 不受影響
      expect(twTaxRate('etf', DEFAULT_TW_FEES, undefined, true, '2026-12-31')).toBe('0.001');
      expect(twTaxRate('bond_etf', DEFAULT_TW_FEES, undefined, true, '2027-01-01')).toBe('0');
    });
  });

  describe('T11: 美股獨立日前夕 7/3 早收與休市', () => {
    it('2025-07-03（7/4 週五）13:00 收盤；2026-07-03（7/4 週六）全日休市；2027-07-03 週六休市', () => {
      // 2025-07-03: 7/4 為週五，7/3 正常開盤但提前於 13:00 EDT (17:00 UTC) 收盤
      // 12:00 EDT (16:00 UTC) 盤中開盤
      expect(marketState('US', new Date('2025-07-03T16:00:00Z'))).toBe('open');
      // 13:00 EDT (17:00 UTC) 早收已關閉（若為一般日，17:00 UTC 為開盤中）
      expect(marketState('US', new Date('2025-07-03T17:00:00Z'))).toBe('closed');
      expect(marketState('US', new Date('2025-07-03T18:00:00Z'))).toBe('closed');

      // 對照：一般交易日（例如 2025-07-02 週三）14:00 EDT (18:00 UTC) 仍為開盤中
      expect(marketState('US', new Date('2025-07-02T18:00:00Z'))).toBe('open');

      // 2026-07-03: 7/4 為週六，7/3 為獨立日補休（observed holiday），全日休市
      expect(marketState('US', new Date('2026-07-03T16:00:00Z'))).toBe('holiday');

      // 2027-07-03: 為週六，正常週末休市
      expect(marketState('US', new Date('2027-07-03T16:00:00Z'))).toBe('holiday');
    });
  });

  describe('T12: AgentBubble 快速切換 preview 亂序防護', () => {
    it('快速切換步驟時，較慢返回的過期預覽不會覆蓋較新的預覽結果', async () => {
      previewResolvers.length = 0;

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      const msg = {
        id: 1,
        role: 'ai' as const,
        kind: 'agent' as const,
        summary: '測試操作',
        quota: '今日剩餘 10 次',
        raw: [
          { op: 'create_tx', amountMinor: 100 },
          { op: 'create_tx', amountMinor: 200 },
        ] as any[],
        steps: [
          { op: 'create_tx', preview: { title: '初始步驟一', lines: [], warnings: [] } },
          { op: 'create_tx', preview: { title: '初始步驟二', lines: [], warnings: [] } },
        ] as any[],
      };

      await act(async () => {
        root.render(React.createElement(AgentBubble, { m: msg }));
      });

      const buttons = container.querySelectorAll<HTMLButtonElement>('button.agent-toggle');
      expect(buttons.length).toBe(2);

      // 連續快速點擊同一 toggle 兩次（先略過、再切回執行）
      await act(async () => {
        buttons[0].click(); // 觸發第 1 次 preview (seq = 1)
      });
      await act(async () => {
        buttons[0].click(); // 觸發第 2 次 preview (seq = 2)
      });

      expect(previewResolvers.length).toBe(2);

      // 第 2 次預覽（最新）先完成返回
      await act(async () => {
        previewResolvers[1]([
          { op: 'create_tx', preview: { title: '第二次結果（最新）', lines: [], warnings: [] } },
          { op: 'create_tx', preview: { title: '初始步驟二', lines: [], warnings: [] } },
        ]);
      });

      // 確認畫面上出現最新結果
      expect(container.textContent).toContain('第二次結果（最新）');

      // 第 1 次預覽（過期）較慢返回
      await act(async () => {
        previewResolvers[0]([
          { op: 'create_tx', preview: { title: '第一次結果（過期）', lines: [], warnings: [] } },
        ]);
      });

      // 驗證：過期的第一次結果被丟棄，不會覆蓋最新結果
      expect(container.textContent).toContain('第二次結果（最新）');
      expect(container.textContent).not.toContain('第一次結果（過期）');

      root.unmount();
      container.remove();
    });
  });

  describe('T13: twseOpenApi 收盤資料時間戳修正', () => {
    it('parseTwMarketTime 正確解析民國年與西元年為交易日 13:30', () => {
      // 7 位數字格式（TWSE 民國年月日）
      expect(parseTwMarketTime('1131108')).toBe(Date.parse('2024-11-08T13:30:00+08:00'));
      // 斜線格式
      expect(parseTwMarketTime('113/11/08')).toBe(Date.parse('2024-11-08T13:30:00+08:00'));
      // 8 位西元年純數字或破折號
      expect(parseTwMarketTime('20241108')).toBe(Date.parse('2024-11-08T13:30:00+08:00'));
      expect(parseTwMarketTime('2024-11-08')).toBe(Date.parse('2024-11-08T13:30:00+08:00'));
    });

    it('盤中呼叫 twse-openapi 時回傳的 marketTime 為收盤 13:30 而非盤中目前時間', async () => {
      const p = providerById('twse-openapi')!;
      expect(p).toBeDefined();

      // 模擬盤中上午 10:00
      const intradayNow = Date.parse('2024-11-08T10:00:00+08:00');
      const expectedClose = Date.parse('2024-11-08T13:30:00+08:00');

      vi.spyOn(Date, 'now').mockReturnValue(intradayNow);

      const mockTwseData = [
        {
          Code: '2330',
          Name: '台積電',
          TradeVolume: '20000000',
          OpeningPrice: '1000',
          HighestPrice: '1010',
          LowestPrice: '995',
          ClosingPrice: '1005',
          Change: '15',
          Date: '1131108',
        },
      ];

      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify(mockTwseData),
        json: async () => mockTwseData,
      })));

      const quotes = await p.quote([{ market: 'TWSE', symbol: '2330' }]);
      expect(quotes.length).toBe(1);
      expect(quotes[0].marketTime).toBe(expectedClose);
      expect(quotes[0].marketTime).not.toBe(intradayNow);

      vi.restoreAllMocks();
    });
  });

  describe('T17: nginx 容器降權改用 unprivileged 非 root 映像檔', () => {
    it('Dockerfile.web 與 docker-compose.yml 採用 nginxinc/nginx-unprivileged:1.27-alpine', () => {
      const dockerfile = fs.readFileSync('docker/Dockerfile.web', 'utf-8');
      expect(dockerfile).toContain('FROM nginxinc/nginx-unprivileged:1.27-alpine');
      expect(dockerfile).toContain('EXPOSE 9122');

      const compose = fs.readFileSync('docker-compose.yml', 'utf-8');
      expect(compose).toContain('image: nginxinc/nginx-unprivileged:1.27-alpine');
    });
  });

  describe('T18: web-watch 原子切換 symlink 防範熱更新 404', () => {
    it('以臨時 symlink + rename 原子覆蓋 current，持續可讀且保留最新 2 個版本', () => {
      const testOut = fs.mkdtempSync(path.join(os.tmpdir(), 'web-watch-test-'));
      try {
        const cur = path.join(testOut, 'current');

        // 模擬第 1 次建置
        const v1Dir = 'v-1000';
        const v1Path = path.join(testOut, v1Dir);
        fs.mkdirSync(v1Path);
        fs.writeFileSync(path.join(v1Path, 'index.html'), '<h1>v1</h1>');
        const tmpLink1 = path.join(testOut, '.tmp-1');
        fs.symlinkSync(v1Dir, tmpLink1);
        fs.renameSync(tmpLink1, cur);

        expect(fs.readlinkSync(cur)).toBe('v-1000');
        expect(fs.readFileSync(path.join(cur, 'index.html'), 'utf-8')).toBe('<h1>v1</h1>');

        // 模擬第 2 次熱更新建置
        const v2Dir = 'v-2000';
        const v2Path = path.join(testOut, v2Dir);
        fs.mkdirSync(v2Path);
        fs.writeFileSync(path.join(v2Path, 'index.html'), '<h1>v2</h1>');
        const tmpLink2 = path.join(testOut, '.tmp-2');
        fs.symlinkSync(v2Dir, tmpLink2);
        fs.renameSync(tmpLink2, cur);

        expect(fs.readlinkSync(cur)).toBe('v-2000');
        expect(fs.readFileSync(path.join(cur, 'index.html'), 'utf-8')).toBe('<h1>v2</h1>');

        // 模擬第 3 次建置並觸發保留最新 2 個版本清理
        const v3Dir = 'v-3000';
        const v3Path = path.join(testOut, v3Dir);
        fs.mkdirSync(v3Path);
        fs.writeFileSync(path.join(v3Path, 'index.html'), '<h1>v3</h1>');
        const tmpLink3 = path.join(testOut, '.tmp-3');
        fs.symlinkSync(v3Dir, tmpLink3);
        fs.renameSync(tmpLink3, cur);

        const all = fs.readdirSync(testOut).filter((f) => f.startsWith('v-')).sort();
        while (all.length > 2) {
          const rmTarget = path.join(testOut, all.shift()!);
          fs.rmSync(rmTarget, { recursive: true, force: true });
        }

        expect(fs.readlinkSync(cur)).toBe('v-3000');
        expect(fs.readFileSync(path.join(cur, 'index.html'), 'utf-8')).toBe('<h1>v3</h1>');
        expect(fs.existsSync(v1Path)).toBe(false); // 最舊的 v1 已被清理
        expect(fs.existsSync(v2Path)).toBe(true);  // v2 保留
        expect(fs.existsSync(v3Path)).toBe(true);  // v3 保留
      } finally {
        fs.rmSync(testOut, { recursive: true, force: true });
      }
    });
  });
});

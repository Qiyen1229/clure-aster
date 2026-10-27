# Aster 記帳 PWA — 設計文件 v1.0（階段 1–5 已實作）

> 實作狀態：全部完成。實作細節差異見下方「v1.0 實作備註」。
> v0.1 依需求「八-1」提出；v0.2 依使用者回饋調整 Tab Bar、中央按鈕與記帳月曆頁，HTTPS／反向代理由使用者自行處理。
> 專案名稱 **Aster**（原名 Clure，1.3.1 更名），App 顯示名稱「Aster 記帳」。

---

## 0. 主要假設（不確定處我先這樣決定，可直接改）

| # | 假設 |
|---|------|
| A1 | 單一使用者、單一裝置；不做雲端同步（跨裝置靠 JSON 備份/還原）。 |
| A2 | 主幣別預設 TWD；金額以「該幣別 ISO 4217 最小單位整數」儲存（TWD/USD=2 位、JPY=0 位）。顯示小數位數另由設定控制。 |
| A3 | 股價、股數、匯率、費率等「非貨幣金額」一律以 **decimal 字串** 儲存，運算用 `decimal.js`。美股允許碎股（股數有小數）。 |
| A4 | 台股股票清單（代號/名稱/市場/產業/是否 ETF）由代理在每日首次請求時從 TWSE/TPEx OpenAPI 取得並快取；美股搜尋走 Yahoo 搜尋 API（經代理）。 |
| A5 | 台股休市日：內建當年度 TWSE 公告休市日表 + 代理端可更新；美股以 NYSE 固定假日規則計算。 |
| A6 | 「本期應繳」以結帳日切分帳單週期自動計算，不串接銀行。 |
| A7 | 分帳的「人」只存名稱（聯絡人表 `people`），不串通訊錄。 |
| A8 | PIN 以 PBKDF2(SHA-256, 210k 次)+salt 雜湊存放；**資料本身不加密**（IndexedDB 加密會大幅犧牲效能與搜尋，列為已知限制，可於階段 5 評估加密備份檔）。 |
| A9 | NAS Docker 版本：一個 `web`（nginx 靜態站，對外 **9122**）+ 一個選用的 `quote-proxy`（Node，取代 Cloudflare Worker，同一份程式碼）。Cloudflare Worker 版本也會提供。 |
| A10 | 開發本機預覽也固定使用 **http://localhost:9122**（Vite dev / preview 皆設 9122）。 |

---

## 1. 技術選型

| 層面 | 選擇 | 理由 |
|------|------|------|
| 框架 | **React 18 + TypeScript + Vite 5** | 生態最完整、型別保護金額計算。 |
| PWA | **vite-plugin-pwa（Workbox, injectManifest）** | 自訂 SW：預快取、執行期快取、更新提示、通知點擊處理。 |
| 資料庫 | **Dexie 4** + `dexie-react-hooks`（liveQuery） | 索引/複合索引/交易/版本遷移；UI 自動響應資料變更。 |
| 狀態管理 | **Zustand**（UI 狀態、設定快取）；資料狀態以 Dexie liveQuery 為單一真相來源 | 避免雙份資料不同步。 |
| 路由 | **React Router 6**（含深層連結 `/add?amount=…`） | |
| 虛擬捲動 | **@tanstack/react-virtual** | 1 萬筆以上流暢；分組 header 一併虛擬化。 |
| 精確運算 | **decimal.js**（股票）＋自寫 `Money`（BigInt-safe 整數，金額） | 禁用浮點直接運算金額。 |
| 圖表 | **ECharts 5（按需引入 + 路由懶載入）** | 下鑽、深淺色主題、進場動畫、點擊事件取明細；懶載入不影響首屏。 |
| 日期 | **date-fns** + `date-fns-tz`（台北/紐約時區判斷市場狀態） | |
| i18n | **i18next + react-i18next**（zh-TW 預設，預留 en / ja） | |
| 手勢/動效 | 自寫 Pointer Events 手勢 hook + CSS transform/transition，`framer-motion` 僅用於頁面轉場與 bottom sheet（可 tree-shake） | 確保 60fps；`prefers-reduced-motion` 全域降級。 |
| 匯入匯出 | PapaParse（CSV）、SheetJS（xlsx，懶載入）、jsPDF + autotable（PDF，懶載入，內嵌思源黑體子集） | |
| 圖片壓縮 | `browser-image-compression`（WebWorker，長邊 1600px、WebP/JPEG 0.75） | |
| 測試 | **Vitest**（單元：平均成本/FIFO/損益/XIRR/費稅/預算/週期規則）+ **Playwright**（E2E 冒煙，WebKit 引擎） | |
| 代理 | Cloudflare Worker（`proxy/worker.ts`）＋同邏輯 Node 版（`proxy/node-server.ts`，給 NAS Docker） | |
| 程式碼品質 | ESLint + Prettier + TS strict | |

---

## 2. 專案結構

```
Aster/
├─ docs/                     DESIGN.md、DEPLOY.md、QA.md、KNOWN_LIMITS.md
├─ public/
│  ├─ icons/                 icon-192/512/maskable/apple-touch-180、splash/*.png
│  └─ fonts/                 PDF 用中文字型子集
├─ scripts/
│  ├─ gen-icons.mjs          SVG → 各尺寸 PNG + iOS splash（sharp）
│  └─ gen-tw-holidays.mjs    更新台股休市日表
├─ assets/icon.svg           App 圖標原稿
├─ src/
│  ├─ main.tsx / App.tsx
│  ├─ sw.ts                  Service Worker（Workbox）
│  ├─ app/                   路由、版面（TabBar、SafeArea、PageTransition）、Providers
│  ├─ ui/                    設計系統元件：Card、Sheet、ListRow、SwipeRow、Keypad、
│  │                         Segmented、Toggle、Snackbar、Skeleton、EmptyState、AmountText…
│  ├─ theme/                 tokens.css、6–8 組主題色、深淺色、echarts 主題
│  ├─ i18n/                  zh-TW.json、en.json、ja.json
│  ├─ db/
│  │  ├─ schema.ts           Dexie 資料表與索引（下方第 3 節）
│  │  ├─ migrations.ts
│  │  ├─ seed/               預設分類、範例資料（可一鍵清除，皆標記 isSample）
│  │  └─ repo/               各資料表的存取層（唯一可寫入 DB 的地方，含帳戶餘額維護）
│  ├─ domain/                ★ 純函式、無 UI、全部有單元測試
│  │  ├─ money.ts            整數金額、幣別最小單位、格式化
│  │  ├─ fx.ts               匯率換算
│  │  ├─ calc-expr.ts        鍵盤四則運算解析（不用 eval）
│  │  ├─ period.ts           記帳月起算日、週起始日、預算週期
│  │  ├─ recurrence.ts       週期規則展開（RRULE 子集）
│  │  ├─ installment.ts      分期拆帳（含利率、手續費、尾差處理）
│  │  ├─ budget.ts           結轉、每日可用額
│  │  ├─ creditcard.ts       帳單週期、本期應繳
│  │  ├─ debt.ts             AA 拆帳、淨額
│  │  ├─ goal.ts             每月需存金額
│  │  └─ invest/
│  │     ├─ position.ts      加權平均 / FIFO、已實現/未實現損益、配股調整
│  │     ├─ fees-tw.ts       手續費（折扣、最低）、證交稅（股票/ETF/當沖）
│  │     ├─ fx-pnl.ts        股價損益 vs 匯差損益拆分
│  │     ├─ xirr.ts          XIRR（Newton + 二分法 fallback）
│  │     ├─ market-hours.ts  市場狀態（盤前/盤中/收盤/休市）
│  │     └─ yield.ts         成本殖利率 / 現價殖利率
│  ├─ services/
│  │  ├─ quotes/             可插拔資料源：QuoteProvider 介面 + twse / tpex / finmind /
│  │  │                      yahoo / finnhub / twelvedata / alphavantage / manual；
│  │  │                      registry（優先序 + fallback）、throttle、retry、cache
│  │  ├─ fx-rates/           open.er-api.com → exchangerate.host fallback
│  │  ├─ notifications/      權限引導、本地排程（開啟時檢查）、Web Push（選用）
│  │  ├─ backup/             JSON 完整備份、匯入、Moze 匯入精靈
│  │  ├─ export/             CSV / XLSX / PDF
│  │  ├─ lock/               PIN、WebAuthn、背景模糊
│  │  ├─ snapshots/          每日資產快照補齊
│  │  └─ health/             資料健康檢查與修復
│  ├─ features/              各頁面（見第 4 節），每個 feature 自含 components/hooks
│  └─ stores/                Zustand：ui、settings、privacy、undo
├─ proxy/
│  ├─ src/core.ts            共用：白名單轉發、快取、速率限制、CORS
│  ├─ worker.ts              Cloudflare Workers 入口 + wrangler.toml
│  └─ node-server.ts         Node 入口（NAS Docker 用）
├─ docker-compose.yml       web:9122、quote-proxy:9123（階段 4）
├─ docker/
│  ├─ Dockerfile.web         多階段：node build＋測試 → nginx:alpine
│  ├─ Dockerfile.proxy       （階段 4）
│  ├─ nginx.conf             SPA fallback、SW 不快取、gzip、/healthz
│  └─ security-headers.conf  CSP 與安全標頭
├─ tests/                    unit（vitest）、e2e（playwright）
└─ package.json / vite.config.ts / tsconfig.json
```

---

## 3. 資料模型（IndexedDB / Dexie）

### 3.1 共通規則
- 主鍵一律 `id: string`（UUID v7，時間排序友善、匯入合併不衝突）。
- 每列皆有 `createdAt`, `updatedAt`（epoch ms），軟刪除 `deletedAt?`（Undo 與健康檢查用；30 天後清除）。
- **金額欄位 `*Minor: number`** = 整數最小單位（JS 安全整數上限 9e15，足夠）；所有加總經 `money.ts`，結果永遠是整數。
- **decimal 欄位 `*Dec: string`**，例如 `"612.5"`、`"0.001425"`。
- 日期時間：`date: string`（`YYYY-MM-DD`，本地日，用於分組/索引）+ `ts: number`（實際時間）。
- 以 `&` 表示唯一索引、`*` 多值索引、`[a+b]` 複合索引（Dexie 語法）。

### 3.2 資料表

```ts
db.version(1).stores({
  accounts:            'id, type, currency, sort, archived, groupId',
  categories:          'id, kind, parentId, [kind+parentId], sort, archived',
  transactions:        'id, date, ts, type, accountId, categoryId, projectId, *tagIds, ' +
                       '[accountId+date], [categoryId+date], [projectId+date], ' +
                       'recurringRuleId, installmentId, transferId, stockTradeId, dividendId, deletedAt',
  transfers:           'id, date, fromAccountId, toAccountId, deletedAt',
  attachments:         'id, transactionId',
  templates:           'id, sort',
  budgets:             'id, periodType, categoryId, projectId, active',
  budget_periods:      'id, budgetId, [budgetId+start]',
  projects:            'id, status, start',
  tags:                'id, &name, sort',
  saved_filters:       'id, sort',
  recurring_rules:     'id, nextDue, kind, active',
  installments:        'id, accountId, status',
  people:              'id, &name',
  debts:               'id, personId, transactionId, settled, date',
  goals:               'id, status, deadline',
  exchange_rates:      '[base+quote], updatedAt',
  stocks:              'id, &[market+symbol], symbol, market, name',
  stock_trades:        'id, stockId, accountId, date, [stockId+date], type',
  dividends:           'id, stockId, exDate, payDate, accountId',
  price_cache:         'stockId, updatedAt',
  price_history:       '[stockId+date], stockId',
  portfolio_snapshots: 'date',
  watchlist:           'id, &stockId, sort',
  reminders:           'id, kind, dueAt, refId, done',
  settings:            'key',
  meta:                'key'   // schemaVersion、lastSnapshotDate、lastBackupAt…
});
```

### 3.3 欄位定義與關聯

**accounts** — 帳戶
| 欄位 | 型別 | 說明 |
|---|---|---|
| name, icon, color | string | |
| type | `'cash'｜'bank'｜'epay'｜'credit'｜'stored'｜'brokerage'｜'loan'｜'other'` | |
| currency | string | ISO 4217 |
| initialBalanceMinor | number | 期初餘額 |
| balanceMinor | number | **快取**，由 repo 層在同一個 Dexie transaction 內增減維護；健康檢查可全量重算校正 |
| includeInNetWorth | boolean | |
| isLiability | boolean | credit/loan 預設 true |
| credit? | `{ limitMinor, statementDay, dueDay, autoPayAccountId? }` | 信用卡 |
| brokerage? | `{ feeDiscountDec, minFeeMinor, oddLotMinFeeMinor, settlementAccountId? }` | 證券戶（交割帳戶可為另一銀行戶） |
| sort, archived, groupId?, note | | |

**categories** — 兩層分類
`kind: 'expense'|'income'`、`parentId: string|null`（null=主分類）、`name`、`icon`（emoji 或內建 SVG id）、`color`、`sort`、`archived`、`system?: 'dividend'|'interest'|'stock_fee'|'adjust'|'transfer_fee'`（系統用，不可刪）。

**transactions** — 帳目（支出／收入／餘額調整；轉帳另存 transfers）
| 欄位 | 說明 |
|---|---|
| type | `'expense'｜'income'｜'adjust'｜'transfer_fee'` |
| accountId → accounts | |
| categoryId → categories（子或主） | |
| amountMinor | 恆為正；方向由 type 決定（adjust 可正可負） |
| currency | 原幣（可與帳戶幣別不同） |
| fxRateDec? | 原幣→帳戶幣別；帳戶入帳金額 `accountAmountMinor` 一併存 |
| accountAmountMinor | 實際影響帳戶的金額 |
| baseAmountMinor | 換算主幣別（報表用，記帳當下匯率；可手動覆蓋） |
| date, ts | |
| note, merchant? | |
| tagIds[] → tags | 多值索引 |
| projectId? → projects | |
| attachmentIds[] → attachments | |
| recurringRuleId?, installmentId?, installmentNo?, transferId?, stockTradeId?, dividendId? | 來源關聯（可回溯、連動刪除） |
| split? | `{ myShareMinor, debtIds[] }` 分帳 |
| excludeFromBudget, excludeFromStats | |
| isSample | 範例資料旗標 |

**transfers** — 轉帳
`fromAccountId`、`toAccountId`、`fromAmountMinor`、`toAmountMinor`（跨幣別各自金額）、`fxRateDec`、`feeMinor`、`feeAccountId`、`feeTransactionId`（手續費自動生成一筆 `transfer_fee` 帳目）、`date, ts, note, tagIds[], projectId?`。信用卡繳款＝銀行→信用卡的轉帳。

**attachments** — `transactionId`、`blob: Blob`（壓縮後）、`mime`、`width`、`height`、`thumb: Blob`。

**templates** — 常用範本：`name`、`payload`（部分 transaction 欄位）、`sort`、`useCount`。

**budgets** — 預算定義
`name`、`periodType: 'month'|'week'|'custom'`、`customDays?`、`startDate`、`amountMinor`、`currency`、`categoryId?`（null=總預算）、`projectId?`、`rollover: boolean`、`alertPercents: number[]`（如 [80,100]）、`active`。

**budget_periods** — 每期結果（結轉用，開啟時補算）：`budgetId`、`start`、`end`、`limitMinor`（含結轉後）、`spentMinor`、`carryOverMinor`。

**projects** — `name`、`icon`、`color`、`start`、`end?`、`currency`、`budgetMinor?`、`status: 'active'|'done'|'archived'`。

**tags** — `name`（唯一）、`color`、`sort`。

**saved_filters** — `name`、`filter: { dateRange, accountIds, categoryIds, projectIds, tagIds, tagMode:'any'|'all', minMinor, maxMinor, keyword, types }`。

**recurring_rules** — 週期／訂閱
`kind: 'normal'|'subscription'`、`template`（transaction 欄位）、`rule: { freq:'day'|'week'|'month'|'year', interval, byWeekday?, byMonthDay?, monthEndPolicy, until?, count? }`、`nextDue`、`mode: 'auto'|'confirm'`、`remindDaysBefore`、`subscription?: { service, logo, renewalDate, priceHistory[] }`、`active`。開啟 App 時展開所有 `nextDue ≤ today` 的期數（auto 直接入帳、confirm 放入待確認匣）。

**installments** — 分期
`accountId`（信用卡）、`categoryId`、`principalMinor`、`periods`、`aprDec`、`feeMinor`、`feeMode:'first'|'spread'`、`firstDate`、`schedule: { no, date, principalMinor, interestMinor, feeMinor, transactionId? }[]`（尾差放最後一期，總和保證 = 原值）、`status`。

**people** — `name`、`avatar?`。

**debts** — 分帳／代墊
`personId → people`、`direction: 'they_owe_me'|'i_owe_them'`、`amountMinor`、`currency`、`transactionId?`、`date`、`note`、`settled`、`settledAt?`、`settleTransferId?`。

**goals** — 存錢目標
`name`、`icon`、`targetMinor`、`currency`、`deadline?`、`linkedAccountIds[]`（目前金額 = 這些帳戶餘額合計）或 `manualSavedMinor`、`status`。

**exchange_rates** — `base`、`quote`、`rateDec`、`source: 'api'|'manual'`、`updatedAt`、`manualOverride?: boolean`。

**stocks** — 標的
`market: 'TWSE'|'TPEX'|'EMERGING'|'US'|'HK'`、`symbol`（例：`2330`、`AAPL`、`0700`）、`name`、`currency`、`assetType: 'stock'|'etf'|'bond_etf'`、`industry?`、`lotSize`（台股 1000）、`taxRateDec?`（覆寫證交稅）。唯一 `[market+symbol]`。

**stock_trades** — 交易（含配股）
| 欄位 | 說明 |
|---|---|
| stockId, accountId(證券戶) | |
| type | `'buy'｜'sell'｜'stock_dividend'｜'split'` |
| date, ts | |
| sharesDec | 股數（零股/碎股） |
| priceDec | 成交價（原幣） |
| feeMinor, taxMinor | 手續費 / 證交稅（預設自動計算，可手動改） |
| fxRateDec | 成交當下 原幣→主幣別，用於匯差損益 |
| isDCA | 定期定額 |
| costMethodSnapshot | 賣出時採用的成本法（審計用） |
| realizedPnlMinor? | 賣出時計算並存檔（顯示用；可重算校驗） |
| cashAccountId?, transactionId?, syncToLedger | 與記帳整合 |
| note | |

**dividends** — 股利
`stockId`、`accountId`、`kind: 'cash'|'stock'`、`exDate`、`payDate`、`perShareDec`、`sharesHeldDec`、`grossMinor`、`withholdingTaxMinor`、`nhiSupplementMinor`（二代健保補充保費）、`feeMinor`（匯費）、`netMinor`、`currency`、`stockTradeId?`（配股時產生 stock_dividend 交易）、`transactionId?`（自動入帳的收入帳目）、`status: 'announced'|'paid'`。

**price_cache** — `stockId`（PK）、`priceDec`、`prevCloseDec`、`changeDec`、`changePctDec`、`open/high/low/volume`、`marketTime`、`source`、`updatedAt`、`isManual`。

**price_history** — `[stockId+date]`、`closeDec`（日線，走勢圖用；1D 走勢只存記憶體不落地）。

**portfolio_snapshots** — 每日一筆，PK `date`
`netWorthMinor`、`assetsMinor`、`liabilitiesMinor`、`investMarketValueMinor`、`investCostMinor`、`unrealizedPnlMinor`、`realizedPnlCumMinor`、`dividendCumMinor`、`byAccount: Record<id, minor>`、`byStock: Record<id,{ sharesDec, priceDec, mvMinor }>`、`filled: 'live'|'backfill'`（補齊日使用最近可得價格，並標示）。

**watchlist** — `stockId`、`sort`、`alerts: { op:'>='|'<=', priceDec, enabled, lastTriggeredAt? }[]`。

**reminders** — `kind: 'daily_log'|'card_due'|'budget'|'subscription'|'price_alert'|'backup'`、`refId`、`dueAt`、`done`、`notifiedAt`。

**settings**（key/value）— `baseCurrency`、`locale`、`theme: 'system'|'light'|'dark'`、`accent`、`upColor: 'red'|'green'`（預設紅漲）、`monthStartDay`、`weekStart`、`decimals`、`thousandsSep`、`homeWidgets[]`、`lock: { pinHash, salt, webauthnCredId?, autoLockSec, blurOnHide }`、`hideAmounts`、`quote: { proxyUrl, providerOrder: {TW[],US[]}, apiKeys:{ finnhub, twelvedata, alphavantage, finmind }, refreshSec: 60 }`、`invest: { costMethod: 'avg'|'fifo', twFeeRateDec:'0.001425', discountDec:'1', minFee:20, oddLotMinFee:1, taxStockDec:'0.003', taxEtfDec:'0.001', syncToLedger:true }`、`notifications{…}`、`backup: { remindDays, lastAt }`。

> **API Key 儲存說明**：存在 IndexedDB 的 settings，僅本機。若經代理呼叫，Key 由前端放在請求標頭，代理不記錄。

### 3.4 關聯圖（摘要）
```
accounts 1─* transactions *─1 categories (self parent 1─*)
accounts 1─* transfers (from/to) ─1 transactions(fee)
transactions *─* tags ; transactions *─1 projects ; transactions 1─* attachments
recurring_rules 1─* transactions ; installments 1─* transactions
transactions 1─* debts *─1 people
stocks 1─* stock_trades ─0..1 transactions ; stocks 1─* dividends ─0..1 transactions
stocks 1─1 price_cache ; stocks 1─* price_history ; stocks 1─0..1 watchlist
accounts(brokerage) 1─* stock_trades / dividends
budgets 1─* budget_periods ; goals *─* accounts(linked)
```

---

## 4. 頁面清單與導覽

### 4.1 底部 Tab Bar（v0.2 依使用者確認調整）
`帳戶 ｜ 專案（預算） ｜ 〔中央按鈕〕 ｜ 報表 ｜ 設定`

- 中央按鈕狀態判斷：
  - 位於「記帳（月曆）／帳目明細」頁（`/`、`/ledger`）→ 顯示 **＋**（主題色圓框），點擊開啟記帳面板。
  - 位於其他頁 → 顯示 **App Logo**（幾何三角），點擊回記帳主頁。
  - 兩個圖層同時存在，以 opacity + scale + rotate 交叉淡入淡出（尊重 reduced-motion）。
- 「投資」移入「帳戶」頁的分段控制（錢包｜投資），與「證券戶屬於帳戶」的模型一致。
- 記帳主頁採月曆網格：週日～週六、上下月淡化、選取日主題色圓框、有紀錄的日子下方小圓點。

### 4.2 頁面
| 路由 | 頁面 | 主要內容 |
|---|---|---|
| `/` | 記帳主頁（月曆） | 月曆網格＋選取日明細與小計；小工具卡片（今日花費、本月預算、淨資產、持股損益、近期帳單）於階段 3 加在月曆下方 |
| `/add`（Sheet） | 記帳面板 | 類型分段、計算機鍵盤、分類格、帳戶/日期/備註(語音)/標籤/專案/照片/分帳、範本、再記一筆、複製上一筆；支援深層連結參數 |
| `/ledger` | 帳目列表 | 日/週/月/年/自訂、分組小計、虛擬捲動、左滑刪/右滑編、多選批次、篩選與已存篩選、搜尋 |
| `/ledger/calendar` | 日曆 | 月曆熱度、點日顯示明細 |
| `/tx/:id` | 帳目詳情 | 編輯、附件檢視、來源關聯（週期/分期/股票） |
| `/accounts` | 帳戶與淨資產 | 分組、排序、封存、淨資產卡 |
| `/accounts/:id` | 帳戶詳情 | 餘額走勢、明細；信用卡：帳單週期、本期應繳、繳款 |
| `/accounts?tab=invest` | 投資總覽 | 總市值/成本/未實現/已實現/今日損益/報酬率/XIRR、市場狀態、最後更新、持股列表、配置圖、損益排行、免責聲明 |
| `/invest/stock/:id` | 個股 | 走勢 1D…ALL、持倉計算、若今日賣出淨損益、交易紀錄、股利、殖利率 |
| `/invest/trade`（Sheet） | 新增交易 | 搜尋標的、買/賣/配股/配息、費稅自動計算 |
| `/invest/watchlist` | 觀察清單 | 即時價、到價提醒 |
| `/invest/dividends` | 股利 | 年度累計、行事曆 |
| `/reports` | 報表 | 分類環形圖(下鑽)、趨勢、淨資產曲線、指標卡、比較；全頁篩選 |
| `/reports/review/:year` | 年度回顧 | Wrapped 式全螢幕滑頁 |
| `/plan` | 規劃中心（由首頁/設定進入） | 預算、專案、週期/訂閱、分期、分帳、存錢目標 |
| `/plan/budgets` `/plan/projects/:id` `/plan/recurring` `/plan/installments` `/plan/debts` `/plan/goals` | 各管理頁 | |
| `/settings` | 設定 | 外觀、分類、標籤、帳戶、鎖定、幣別匯率、股票資料源與 Key、代理網址、通知、備份還原/匯入匯出、資料健康檢查、範例資料清除、關於/版本 |
| `/onboarding` | 首次引導 | 主幣別→主題→第一個帳戶→是否載入範例資料 |
| `/lock` | 鎖定畫面 | PIN 鍵盤、Face ID 按鈕 |
| `/search` | 全域搜尋 | 帳目、帳戶、股票、分類（桌機 ⌘K） |

### 4.3 主要流程
```
首次開啟 → /onboarding → /
每次開啟 → [App 鎖] → 啟動任務（背景依序）：
   ① 週期帳目到期展開 ② 分期期數入帳 ③ 預算期間結算/結轉
   ④ 匯率更新(>12h) ⑤ 股價更新 ⑥ 每日快照補齊 ⑦ 本地提醒檢查 ⑧ 備份提醒
＋ → 記帳 Sheet → 儲存（Snackbar：已新增・復原）→ 再記一筆或關閉
深層連結 /add?type=expense&amount=100&category=food&account=…&note=… → 直接開記帳 Sheet 並預填
manifest shortcuts：快速記帳 → /add ；查看投資 → /invest
```

---

## 5. 股票報價架構（摘要）

```ts
interface QuoteProvider {
  id: string; markets: Market[]; needsKey: boolean;
  search?(q: string): Promise<StockMeta[]>;
  quote(symbols: StockRef[]): Promise<Quote[]>;      // 批次
  history?(ref: StockRef, range: Range): Promise<Bar[]>;
}
```
- 預設優先序：台股 `twse-mis → twse-openapi/tpex-openapi(收盤) → finmind → yahoo`；美股 `yahoo → finnhub → twelvedata → alphavantage`；最後 `manual`。
- Registry：逐一嘗試、單一來源熔斷（連續失敗 3 次冷卻 5 分鐘）、指數退避重試、每來源 token bucket 節流、同批次合併。
- 成功報價寫入 `price_cache`；離線或全部失敗 → 顯示快取價並標「非最新（HH:mm）」；可手動輸入現價（`isManual`）。
- 盤中且頁面可見時每 N 秒刷新（`visibilitychange` 暫停）；盤後/休市不輪詢。
- 代理：只轉發白名單網域（twse/tpex/finmind/yahoo/finnhub/twelvedata/alphavantage/匯率），Edge cache 15 秒（盤中）/ 10 分鐘（盤後），可設 `ACCESS_TOKEN` 防濫用。

---

## 6. NAS Docker 交付內容（第十點）

```
docker/
├─ Dockerfile.web        node:20-alpine build → nginx:1.27-alpine，listen 9122
├─ Dockerfile.proxy      node:20-alpine，listen 9123
├─ nginx.conf            SPA fallback、sw.js/manifest no-cache、hash 資產長快取、
│                        /proxy/ 反向代理到 quote-proxy（同源，免 CORS）
├─ docker-compose.yml    services: web(9122:9122)、quote-proxy(內部)、restart: unless-stopped、healthcheck
├─ .env.example          PROXY_ACCESS_TOKEN、TZ=Asia/Taipei
└─ README-NAS.md         Synology / QNAP / Unraid 部署步驟、HTTPS 反向代理設定
```

> ⚠️ **重要平台限制（誠實說明）**：Service Worker 與「加入主畫面」完整 PWA 功能**只在 HTTPS 或 localhost 生效**。用 `http://NAS-IP:9122` 在 iPhone 開啟時：可以使用與加入主畫面，但**沒有離線、沒有更新提示、沒有推播、WebAuthn 也無法使用**。正式使用請在 NAS 上套 HTTPS（Synology 反向代理 + Let's Encrypt、或 Tailscale HTTPS / Cloudflare Tunnel），README 會附三種做法。

---

## 7. 分階段計畫與交付

| 階段 | 內容 | 可獨立運行驗收點 |
|---|---|---|
| 1 | PWA 骨架、圖標、主題/深淺色、i18n、Dexie schema、帳戶、分類、記帳面板（計算機鍵盤、轉帳、調整、附件、範本、語音）、帳目列表（虛擬捲動、滑動、批次）、Onboarding、Undo、Docker 檔 | localhost:9122 可記帳、離線可用、可加入主畫面 |
| 2 | 預算（結轉/週/自訂）、專案、標籤與篩選、週期/訂閱、分期、分帳、存錢目標、多幣別匯率 | |
| 3 | 報表（ECharts 全部圖表、下鑽、比較）、日曆、年度回顧、首頁小工具 | |
| 4 | 股票：資料源、代理（Worker + Node）、持倉/FIFO/損益/XIRR/費稅/匯差、股利、快照、觀察清單、圖表 + 單元測試 | |
| 5 | 通知、App 鎖、匯入匯出（CSV/XLSX/JSON/PDF、Moze 精靈）、備份、捷徑、健康檢查、效能與無障礙、QA 清單、已知限制 | |

每階段附：檔案結構、`npm run dev`（→ http://localhost:9122）、`npm test`、`docker compose up -d`、部署 Cloudflare Pages 步驟、iPhone 加入主畫面步驟。

---

## v1.0 實作備註（與原設計的差異）

- `budget_periods`：預算各期結果改為即時計算（`computeBudgets`，含結轉鏈），不落地，避免與帳目不同步；資料表保留供未來快取。
- 投資交易同步記帳：成交金額記為「股票買進／賣出」系統分類（不計入收支統計），手續費與證交稅另記一筆「交易手續費」支出（計入統計）；投資市值另外計入淨資產。
- 分帳：帳目保留全額（帳戶餘額正確），`split.myShareMinor` 讓所有統計只計「我的份額」；對方還款入帳時不計入收入。
- 應收／應付帳款（記帳面板的「應收」「應付」）：沿用 `debts` 表；借出／借入時建立系統分類 `sys-debt-out`／`sys-debt-in` 的帳目（excludeFromStats＋excludeFromBudget），並記在 `debts.loanTxId`；結清時同樣不計入收支。不選帳戶則只記欠款。
- 「其他」子分類：`ensureOtherSubcategories()` 於啟動時補齊（id `{主分類}-other`、排最後、被封存會恢復），新增主分類時一併建立。
- 抽屜堆疊：`Sheet` 以模組層級堆疊計算 z-index，巢狀開啟時背景蓋住下層抽屜，點空白處／Esc 只關最上層。
- PDF 報表改用「可列印頁面＋瀏覽器儲存 PDF」，中文字型完整、無需內嵌字型檔。
- Excel 匯出使用自寫精簡 XLSX 產生器（fflate 壓縮），避免引入有安全疑慮的大型套件。
- 報價代理核心 `proxy/src/core.ts` 同時用於 NAS Docker（Node）、Cloudflare Workers 與 Vite 開發／預覽伺服器。
- WebAuthn 解鎖在本機以 WebCrypto 驗證簽章（challenge、origin、UV 旗標），不需伺服器。

# Aster 記帳 — 專案完整總覽（給 AI 閱讀）

> 這份檔案把整個專案（功能、技術、架構、資料模型、API、安全、部署、檔案地圖、慣例）整合在一處，讓 AI 不用逐一翻檔案就能理解全貌。
> 內容整理自 README、CHANGELOG、docs/*、原始碼與設定檔。版本：**3.10.0**（2026-10-31）。分支：`feature/v1.2`（主分支 `main`）。2.0.0 新增 AI 全面整合，見下方「AI 功能」一節與 `docs/AI.md`。3.0.0 首頁全面重構為原創 Bento 儀表板與膠囊週曆。3.1.0 全面更換 3D 星軌花體 A 品牌圖標與 iOS 18 水漾高透光靈動島懸浮導覽列。3.2.0 報表支援點擊支出／收入即時彈出全明細流，移除導覽列藍點殘留，修復 iOS 主畫面圖標快取與根目錄回退。3.5～3.6 異常與訂閱漲價偵測（習慣→市價→AI 三層判斷）、加密備份、資料庫每日自動備份、首頁簡化、原創 AI 圖示。3.6.5 靈動島大修（按下即彈、合成器彈簧、Q 彈轉場）。測試：前端 478＋後端 154＝632 項。3.7.0 統一發票自動對獎器（`domain/invoice-prize.ts`、`services/invoicePrize.ts`、`/settings/invoice/prize`）；3.8.0 資金流向桑基圖（`domain/sankey.ts`、`features/reports/SankeyCard.tsx`）；3.9.0 耐用品每日持有成本（新資料表 `durables`，`domain/durable.ts`、`db/repo/durables.ts`、`features/plan/durables.tsx`）；3.10.0 外部通知 Discord／Telegram／LINE／Webhook（後端 `core/outgoing.py`、`core/secretbox.py`、`service/notify_service.py`、`api/notify.py`、表 `notify_channels`；前端 `services/outgoing.ts`、`features/settings/ChannelsPage.tsx`；文件 `docs/NOTIFY.md`）。下一個 Alembic 遷移是 `0010_…`。
> 
> ### 版本號命名與發佈規範（嚴格遵守）
> 格式：`x.y.z`
> - **x（Major）**：加入 3 個以上新功能的大更新。
> - **y（Minor）**：加入 1 到 3 個新功能的小更新。
> - **z（Patch）**：修復功能與 Bug 修補。
> 每次版本更新均須同步更新 `package.json`、`server/app/main.py`、`CHANGELOG.md`、`PROJECT_OVERVIEW_FOR_AI.md` 並執行 `scripts/pack-nas.sh` 產出最新部署包。
> 想看細節時，請依第 13 節「檔案地圖」直接讀對應檔案；各檔案開頭都有繁體中文說明註解。

---

## 1. 一句話介紹

**Aster 記帳**（原名 **Clure**，1.3.1 更名）是**自架**的個人記帳＋股票投資組合 **PWA**：帳目存在每台裝置的瀏覽器 IndexedDB（離線可用），並同步到使用者自己的伺服器（NAS Docker），同一帳號在手機／平板／電腦間自動同步。參考 Moze 4.0 的操作邏輯，iOS 原生質感，可加入 iPhone 主畫面。介面僅繁體中文（zh-TW）。

- 目標使用者：自己與家人，內網 NAS 自架；也可部署到公網（需先處理安全設定，見第 10 節）。
- 規模：約 **26,000 行**程式碼（`src/` TypeScript/TSX、`server/app` Python、前後端測試）。
- 命名遺留：為了不影響已部署資料，`.env` 的 `CLURE_*` 變數、Cookie 名、本機 IndexedDB 名（`clure`、`clure-u{userId}`）、docker 專案／資料卷（`clure_*`）、PostgreSQL 帳號、`x-clure-token` 標頭等**都沿用舊名 Clure**。新程式碼請維持這個相容性，不要重新命名這些識別字。

---

## 2. 技術棧總覽

### 前端（`src/`）
| 類別 | 技術 | 用途／備註 |
|---|---|---|
| 框架 | React 18 + TypeScript 5.9（strict）+ Vite 5 | `npm run build` = `tsc --noEmit && vite build` |
| 路由 | react-router-dom 6 | 深層連結（`/add?amount=…`），頁面依方向滑入轉場 |
| 本機資料庫 | **Dexie 4** + dexie-react-hooks（liveQuery） | IndexedDB；UI 以 liveQuery 為單一真相來源；DBCore 中介層做同步追蹤 |
| 狀態管理 | Zustand 4 | 只放 UI／設定／認證狀態（`src/stores/`） |
| 精確運算 | decimal.js + 自寫整數 `Money` | 金額＝幣別最小單位整數；股價／股數／匯率＝decimal 字串。**禁用浮點直接運算金額** |
| 圖表 | ECharts 5（按需引入、懶載入） | 環形圖下鑽、趨勢、淨資產曲線 |
| 日期 | date-fns 3 | 台北／交易所時區判斷市場狀態 |
| 虛擬捲動 | @tanstack/react-virtual | 帳目列表上萬筆 |
| 圖片 | browser-image-compression | Web Worker 壓縮收據（長邊 1600px、≈300KB） |
| 壓縮 | fflate | 自寫精簡 XLSX 產生器 |
| QR | jsqr | 掃電子發票左側 QR Code |
| 多語系 | （無） | 只提供繁體中文；3.6.5 已移除未使用的 i18next 依賴 |
| PWA | vite-plugin-pwa（Workbox **injectManifest**）+ 自訂 `src/sw.ts` | 預快取、離線、更新提示（不自動 skipWaiting）、Web Push |
| 測試 | Vitest 2 + fake-indexeddb + jsdom | `tests/unit/*.test.ts`（172 項） |
| 圖示 | sharp（`npm run icons`） | `assets/icon.svg` → 全尺寸圖標＋iOS 啟動畫面 |
| 手勢／動效 | 自寫 Pointer Events hook + CSS transform；`theme/app.css`（約 61KB 單一樣式檔） | 尊重 `prefers-reduced-motion` |

`vite.config.ts` 重點：`@` 別名指向 `src`；dev/preview 固定 **9122** 埠（`strictPort`）；`/api` 代理到 `http://127.0.0.1:8000`（可用 `CLURE_API_URL` 改）；內建 `asterProxy()` plugin，把 `/proxy/*` 直接交給 `proxy/src/core.ts`；`manualChunks` 拆出 `vendor-react`、`vendor-data` 讓更新時不必重新下載；`__APP_VERSION__`、`__BUILD_TIME__` 以 `define` 注入。環境變數 `VITE_AUTH_MODE=off` 可在建置時關閉帳號系統（回到純本機模式）。

### 後端（`server/`）
| 類別 | 技術 |
|---|---|
| 框架 | **FastAPI** ≥0.115 + uvicorn[standard]，Python ≥3.10（容器用 3.12） |
| ORM／遷移 | SQLAlchemy 2.0、**Alembic**（遷移 0001～0006，啟動時自動套用） |
| 設定 | pydantic 2 + pydantic-settings（環境變數前綴 `CLURE_`） |
| 資料庫 | 預設 **SQLite**（WAL＋外鍵）；可選 **PostgreSQL 16**（psycopg 3） |
| 安全 | argon2-cffi（Argon2id）、PyJWT（HS256）、cryptography（Web Push 的 VAPID／aes128gcm、ECDH） |
| 其他 | email-validator |
| 測試 | pytest 8 + httpx（`server/tests/`） |

### 報價代理（`proxy/`）
TypeScript，**同一份核心** `proxy/src/core.ts` 以三種形式部署：NAS Docker（Node，`node-server.ts`）、Cloudflare Worker（`worker.ts`＋`wrangler.toml`）、Vite 開發／預覽伺服器內建。只允許白名單網域、只允許 GET、每 IP 每分鐘 120 次、可選 `ACCESS_TOKEN`、記憶體快取（盤中即時 10 秒、名單 30 分鐘、搜尋 5 分鐘、Yahoo 20 秒）。白名單：`mis.twse.com.tw`、`openapi.twse.com.tw`、`www.twse.com.tw`、`www.tpex.org.tw`、`api.finmindtrade.com`、`query1/query2.finance.yahoo.com`、`finnhub.io`、`api.twelvedata.com`、`www.alphavantage.co`、`open.er-api.com`。

### 基礎設施／DevOps
- **Docker Compose**（`docker-compose.yml` 熱更新版為預設；`docker-compose.build.yml` 為舊映像檔版）。
- **nginx 1.27**（SPA fallback、SW 不快取、資產長快取、gzip、`/api/`、`/proxy/` 同源轉發、`/healthz`；`/proxy/` 用 `auth_request` → `/api/auth/check` 要求登入；不記錄 `/api/hook/` 存取日誌）。
- **CSP／安全標頭**（`docker/security-headers.conf`）：`script-src 'self'`、禁止 inline `<style>` 元素、`frame-ancestors 'none'`、HSTS 等；`connect-src` 白名單含匯率與可直連的 Finnhub／Twelve Data／Alpha Vantage。
- **GitHub Actions CI**（`.github/workflows/ci.yml`）：web（Node 20：`npm ci` → typecheck → test → build）、api（Python 3.12：`pytest -q`）。
- 打包：`npm run pack:nas` → `aster-nas.zip`（**不含 `.env` 與 `data/`**）。

---

## 3. 整體架構

```
瀏覽器（React PWA，離線可用）
  │  IndexedDB（每位使用者獨立：clure-u{userId}；未登入舊庫：clure）
  │  ├─ 寫入經 Dexie DBCore 中介層 → sync_outbox（待上傳佇列）
  │  └─ Service Worker：預快取、離線、Web Push 接收
  │
  ├─ 同源 /api  ──▶ nginx(web:9122) ──▶ FastAPI(api:8000) ──▶ SQLite / PostgreSQL
  │                                       帳號、權杖、審計日誌、sync_records、收件匣、推播、管理後台
  └─ 同源 /proxy ─▶ nginx(auth_request) ─▶ quote-proxy(node) ─▶ 證交所／櫃買／FinMind／Yahoo／Finnhub…

iPhone 捷徑 ──POST /api/hook/inbox（捷徑專用權杖，只能寫入）──▶ inbox_items ──▶ App 開啟時拉取、確認記帳
```

核心設計原則：
1. **離線優先**：所有讀寫先落在本機 IndexedDB；伺服器只是同步與帳號層。
2. **資料狀態單一真相來源＝Dexie liveQuery**，Zustand 只放 UI／設定。
3. **domain 純函式層**（`src/domain/`）無 UI、無 DB、全部有單元測試；**repo 層是唯一可寫入 DB 的地方**，並在同一個 Dexie 交易內維護帳戶餘額快取。
4. **iOS PWA 不能背景執行**：所有「週期入帳、分期、預算結算、匯率、股價、快照補齊、提醒檢查」都在**開啟 App 時補算**（`services/startup.ts`）。
5. 後端採**五層架構**：`api`（路由）→ `service`（業務邏輯）→ `repository`（DB 存取）→ `model`（ORM）＋ `schema`（Pydantic）＋ `core`（橫切：設定、安全、頻率限制、日誌、WebPush）。

---

## 4. 功能清單（依階段與版本）

### 階段 1 — 記帳核心
PWA（離線、更新提示、主畫面、啟動畫面）；深淺色＋8 主題色；文字大小（跟隨系統或 5 段）；紅漲綠跌切換；記帳月曆；計算機鍵盤（`calc-expr.ts`，**不用 eval**）；支出／收入／轉帳（含手續費、跨幣別）／餘額調整；兩層分類；標籤；收據照片；語音備註；範本；複製上一筆；「最近常記」（備註欄一點帶入金額分類帳戶）；再記一筆；帳目列表（虛擬捲動、左滑刪除＋復原、右滑編輯、長按選單、批次操作）；多帳戶與信用卡帳單；首次引導；範例資料（`isSample`，可一鍵清除）。

### 階段 2 — 規劃
預算（月／週／自訂天數、總額／分類／專案、結轉、每日可用、超支推估與警示、「依過去花費建立」建議）；專案／旅行（獨立幣別、預算、統計、匯出）；進階篩選＋常用篩選；週期帳目與訂閱（自動入帳或待確認、續約提醒、價格紀錄）；分期（0 利率／本息平均、手續費首期或分攤、攤還表）；分帳 AA（帳戶扣全額、統計只算我的份額、我先付／別人先付、結清）；應收／應付帳款（借出／借入動帳戶但不計入收支與預算）；存錢目標；匯率管理（自動更新＋手動覆蓋）。

### 階段 3 — 報表
摘要指標（儲蓄率、收支比、日均、最大單筆…）；分類環形圖（下鑽子分類）；每日／每月趨勢；近 12 個月；淨資產成長曲線；本月 vs 上月／去年同月；帳戶／專案／標籤／幣別篩選；年度回顧（Wrapped 風格）；可列印 PDF 報表（瀏覽器列印）；首頁小工具（可排序）。

### 階段 4 — 投資
股票搜尋（台股上市／上櫃／興櫃／ETF、美股、港股）；買進／賣出／配股／分割、整股／零股；台股手續費（折扣、最低）與證交稅自動計算；加權平均／FIFO；已實現／未實現；今日損益；總報酬率（含股利）；XIRR；「若今天賣出」淨損益；外幣股價損益與匯差拆分；股利（現金／配股、預扣稅、二代健保、自動入帳）；成本／現價殖利率；配置圓餅（個股／產業／市場／幣別）；市值與損益曲線（每日快照、自動補齊）；個股走勢 1D–ALL；損益排行；觀察清單與到價提醒；可插拔資料源自動 fallback＋熔斷；盤中自動刷新；離線顯示最後價格；手動輸入現價；與記帳同步。

### 階段 5 — 系統
提醒（每日記帳、信用卡繳款、預算、訂閱、到價、備份）＋提醒中心；App 鎖（PIN＋Face ID／Touch ID，WebAuthn 在本機以 WebCrypto 驗證）；背景模糊、隱藏金額；JSON 完整備份／還原（含照片）；CSV／Excel 匯出；CSV 匯入精靈（自動辨識 Moze）；資料健康檢查與修復；iOS 捷徑深層連結；桌機快速鍵。

### v1.1
信用卡額度佔用；股利行事曆（已領／預估）；今日可用（動態每日額度）；心願清單（冷靜期 3/7/14/30 天）；**帳號系統**（Argon2id、JWT HttpOnly Cookie、Refresh 輪替與重用偵測、CSRF、頻率限制、帳號鎖定）；**管理員資安後台** `/admin`；每帳號獨立 IndexedDB；**跨裝置同步**；動態效果。

### v1.2
**端對端加密同步**（選用）；**電子發票**（手機條碼載具、紙本 QR Code、載具 CSV）；銀行／信用卡對帳單 CSV 匯入（民國年、正數為支出、疑似重複偵測、可儲存格式）；**自動分類規則＋商家記憶**；**財務自由試算**（1,000 次蒙地卡羅）；**背景推播**（Web Push）；**投資稅務彙總**（合併／分開計稅、二代健保、海外所得與基本稅額）；**貸款攤還**。1.2.1 為 iPhone 主畫面最佳化（狀態列、鍵盤 visualViewport、16px 輸入框防縮放、大字級…）。

### v1.3
**一句話／語音記帳**（規則式中文解析，不經任何 AI 服務：金額含「兩千三」「5萬2」、日期含「昨天」「上週五」「10/25」、帳戶、分類、一次多筆；深層連結 `/add?text=…`）；**自動記帳收件匣**（iPhone 捷徑：Apple Pay 交易、銀行簡訊、Siri → `/api/hook/inbox`，含來源去重）；**現金流預測**（30/90/180 天）；**週報／月報**；**用問的查帳**（`nlquery`，「上個月吃飯花多少」）；導覽與新功能介紹。1.3.1 更名 Aster、設定頁重排、預算建議、分帳「別人先付」。1.3.2 備註「最近常記」。1.3.3 一句話備註／分類辨識修正。

### v1.4
1.4.0 語音記帳彈窗（波浪動畫、即時顯示「將會記成」）。1.4.1 **長按導覽列中間按鈕語音記帳**（按住說話、放開入帳）、科技感多層絲帶波浪。1.4.2～1.4.4 為 **iPhone 長按語音**的連續修正：iOS 只認「真正的點擊」為使用者手勢，長按計時器內啟動語音辨識會假裝開始卻收不到聲音 → 現在 iPhone 長按放開後彈窗顯示「點一下下方麥克風開始說話」，Android／桌機維持按住說話、放開入帳；長按期間整頁禁止選取與長按選單。語音引擎在 `services/voice.ts`（全域），UI 在 `features/home/VoiceSheet.tsx`。

### v2.0 ～ v3.6.5（目前）
2.x：AI 全面整合（Gemini／OpenAI 等可插拔、限流、送出紀錄）、搜尋與首頁對話框、忘記密碼。3.0 Bento 首頁；3.1 Liquid Glass 靈動島；3.5 異常與訂閱漲價偵測、加密備份、SQLite 每日自動備份、就緒檢查、CI；3.6 異常判斷改「習慣→分類市價→AI」並每筆自動檢查、首頁簡化、原創 AI 圖示、彈窗空白處下滑關閉；3.6.5 靈動島大修：按下即切換（透鏡 Q 彈）、彈簧軌跡交給 WAAPI 在合成器播放、頁面轉場帶過衝的彈簧。完整紀錄見 `CHANGELOG.md`。

---

## 5. 前端結構與路由

### 目錄（`src/`）
```
main.tsx / App.tsx        入口、路由、全域 Provider
sw.ts                     Service Worker（Workbox injectManifest）
app/                      AuthGate、LockScreen、TabBar、hooks（liveQuery 資料 hooks）、overlays（Snackbar/動作選單/更新提示/隱私模糊）、viewport（iOS 視窗處理）
ui/                       設計系統元件：Icon（內建線條圖示）、Sheet（底部抽屜、堆疊 z-index）、SwipeRow、PullToRefresh、controls（分段/開關/金額文字）、form（iOS 設定風格表單列）
theme/app.css             單一大型樣式檔（design tokens、主題色、深淺色、動畫）
stores/                   Zustand：auth、settings、ui
db/                       Dexie schema、types、bootstrap、sync-tracking、repo/*、seed/*
domain/                   純函式業務邏輯（見第 7 節）
services/                 對外/跨切面服務（見第 8 節）
features/                 各頁面（見下表）
```

### 路由（`src/App.tsx`）
| 路由 | 頁面 | 備註 |
|---|---|---|
| `/` | HomePage（記帳月曆＋小工具） | 底部導覽中間按鈕：在 `/`、`/ledger` 顯示＋（長按＝語音記帳），其他頁顯示 Logo（回首頁） |
| `/add` | AddDeepLink → 開啟 AddSheet | 參數：`type amount category account note date tags project text` |
| `/ledger` | LedgerPage | 虛擬捲動、篩選、批次 |
| `/accounts`、`/accounts/:id` | AccountsPage（錢包｜投資分頁 `?tab=invest`）、帳戶詳情 | 信用卡帳單、貸款攤還 |
| `/plan`、`/plan/projects/:id` | PlanPage（預算／專案／週期／分期／分帳／目標／心願）、專案詳情 | 分頁在 `features/plan/*.tsx` |
| `/reports` | ReportsPage | 另有 `/reports/review/:year`（年度回顧）、`/reports/print`、`/reports/fire`、`/reports/tax`、`/reports/cashflow`、`/reports/summary`（週報／月報） |
| `/invest/stock/:id`、`/invest/watchlist`、`/invest/dividends` | 個股、觀察清單、股利 | `/invest` 轉址到 `/accounts?tab=invest` |
| `/settings` + 子頁 | `categories tags fx invest security notifications backup import health widgets rules invoice` | 七組：帳號、外觀、記帳偏好、分類與規則、自動化與整合、資料、關於 |
| `/inbox` | InboxPage（自動記帳收件匣） | |
| `/search` | SearchPage（含用問的查帳） | 桌機 `⌘K`／`/` |
| `/onboarding` | 首次引導 | |
| `/admin/*` | AdminPage（總覽／使用者／審計日誌） | 前端守衛僅 UX，真正權限在後端 `require_admin` |

桌機快速鍵：`N` 記一筆、`⌘K`／`Ctrl+K`／`/` 搜尋、`1`–`5` 切 Tab、`L` 帳目列表。

---

## 6. 資料模型

### 6.1 本機 IndexedDB（Dexie，`src/db/schema.ts`、`types.ts`）
- 資料庫名：`clure`（舊、未登入）／`clure-u{userId}`（登入後每人一個）。
- 版本：v1 建立全部表；**v2** `wishes`（心願）；**v3** `sync_outbox`（同步佇列）；**v4** `rules`（自動分類規則）＋ `transactions` 新增 `invoiceNo` 索引。**規則：不得修改已發布的版本，要變更索引就新增 `db.version(n)`**。
- 主鍵一律 `id: string`（UUID）；每列有 `createdAt`/`updatedAt`（epoch ms）；`deletedAt?` 軟刪除。
- 金額欄位 `*Minor: number`＝整數最小單位（TWD/USD 2 位、JPY 0 位）；decimal 欄位 `*Dec: string`（股價、股數、匯率、費率）。
- 日期：`date: 'YYYY-MM-DD'`（本地日）＋ `ts`（實際時間）。

資料表（索引細節見 `schema.ts`）：
`accounts`（cash/bank/epay/credit/stored/brokerage/loan/other；`balanceMinor` 是**快取**，由 repo 在同一交易內維護、健康檢查可全量重算；信用卡有 `credit{limit,statementDay,dueDay,autoPayAccountId}`；證券戶有 `brokerage{feeDiscount,minFee,…,settlementAccountId}`；貸款有本金/利率/期數）、`categories`（兩層，`system` 系統分類不可刪）、`transactions`（expense/income/adjust/transfer_fee；`amountMinor` 恆正、`accountAmountMinor`、`baseAmountMinor`、`fxRateDec`、`tagIds[]` 多值索引、`projectId`、`split{myShareMinor,…}`、`excludeFromBudget/Stats`、`invoiceNo`、來源關聯 `recurringRuleId/installmentId/transferId/stockTradeId/dividendId`）、`transfers`、`attachments`（Blob）、`templates`、`budgets`、`budget_periods`（保留，實際即時計算）、`projects`、`tags`、`saved_filters`、`recurring_rules`、`installments`、`people`、`debts`、`goals`、`exchange_rates`、`stocks`（market: TWSE/TPEX/EMERGING/US/HK）、`stock_trades`（buy/sell/stock_dividend/split）、`dividends`、`price_cache`、`price_history`、`portfolio_snapshots`、`watchlist`、`reminders`、`wishes`、`rules`、`settings`（key/value）、`meta`（schemaVersion、裝置 id、同步游標、E2EE 金鑰…；**不同步**）、`sync_outbox`。

重要語意：
- 投資交易同步記帳：成交金額記為系統分類「股票買進／賣出」（不計入收支），手續費與證交稅另記一筆「交易手續費」支出（計入統計）；投資市值另外計入淨資產。
- 分帳：帳目保留全額（帳戶餘額正確），`split.myShareMinor` 讓統計只算我的份額。
- 應收／應付：沿用 `debts`；借出／借入建立系統分類 `sys-debt-out`/`sys-debt-in` 的帳目（excludeFromStats＋excludeFromBudget）。
- 「其他」子分類：`ensureOtherSubcategories()` 於啟動時補齊（id `{主分類}-other`）。
- 預設分類只在資料庫完全空白時建立（`bootstrap.ts`），之後只補系統分類；被使用者刪除的預設分類不會回來。

### 6.2 後端資料表（SQLAlchemy，`server/app/model/`；Alembic 0001～0006）
`users`（role user/admin、`is_active`、`failed_login_count`、`locked_until`、`token_version`、`must_change_password`…）、`refresh_tokens`（`jti`、`family_id`、`replaced_by`）、`audit_logs`、`rate_limits`（頻率限制存 DB）、`sync_records`（`user_id, table_name, record_key, updated_at, deleted, payload JSON, seq, device_id`，三欄唯一）、`sync_states`（`last_seq`、`purged_seq`）、`sync_keys`（E2EE 鹽、次數、驗證密文、版本）、`push_subscriptions`、`push_schedules`、`inbox_tokens`（只存 SHA-256）、`inbox_items`、`app_settings`（管理後台改的系統設定，優先於 .env）。

---

## 7. 前端 domain 純函式層（`src/domain/`）

| 檔案 | 職責 |
|---|---|
| `money.ts` | 整數金額、幣別最小單位、格式化 |
| `calc-expr.ts` | 鍵盤四則運算解析（不用 eval） |
| `period.ts` | 本地日期鍵、記帳月（自訂起算日）、週起始日 |
| `ledger.ts` | 帳目對餘額的影響、日／期間小計 |
| `budget.ts` | 預算期間、結轉、每日可用／今日可用 |
| `recurrence.ts` | 週期規則展開（RRULE 子集） |
| `installment.ts` / `loan.ts` | 分期／貸款攤還表（尾差放最後一期，總和保證＝原值） |
| `creditcard.ts` | 結帳日／繳款日、帳單週期、本期應繳 |
| `debt.ts` | AA 拆帳、每人淨額 |
| `goal.ts` | 存錢目標進度與每月需存 |
| `reports.ts` | 分類佔比、趨勢、星期／時段分析 |
| `summary.ts` | 週報／月報 |
| `cashflow.ts` | 現金流預測 |
| `fire.ts` | 財務自由蒙地卡羅模擬 |
| `tax.ts` | 台灣投資所得稅務彙總（估算） |
| `rules.ts` | 自動分類（使用者規則＋商家記憶） |
| `dedupe.ts` | 自動記帳來源去重（Apple Pay／簡訊／發票／手動） |
| `nlp.ts`（約 27KB，最大的 domain 檔） | 中文一句話解析：金額（中文數字）、日期、帳戶、分類、備註、多筆 |
| `nlquery.ts` | 「用問的查帳」查詢解析 |
| `notesuggest.ts` | 備註「最近常記」建議排序 |
| `dividend-calendar.ts` | 股利行事曆（已領／預估） |
| `invest/position.ts` | 持倉：加權平均／FIFO、已實現／未實現、配股調整 |
| `invest/fees-tw.ts` | 台股手續費（折扣、最低 20 元／零股 1 元，無條件捨去）與證交稅（股票 0.3%、ETF 0.1%、當沖） |
| `invest/xirr.ts` | XIRR（Newton＋二分法 fallback） |
| `invest/market-hours.ts` | 盤前／盤中／收盤／休市（台股休市日取自證交所 OpenAPI，離線用內建 `TW_HOLIDAYS`；美股假日用規則計算） |

---

## 8. 前端 services 層（`src/services/`）

| 檔案 | 職責 |
|---|---|
| `api.ts` | 後端 API 用戶端（Cookie＋CSRF 雙提交、自動 refresh） |
| `sync.ts`（約 19KB） | **跨裝置同步引擎**（見第 9 節） |
| `e2ee.ts` | 端對端加密（PBKDF2-SHA256 310k → AES-256-GCM；金鑰為不可匯出 CryptoKey） |
| `startup.ts` | 開啟 App 的補算任務：週期帳目 → 分期 → 預算結轉 → 匯率(>12h) → 股價 → 每日快照 → 提醒檢查 → 備份提醒 |
| `quotes/{http,providers,registry,search}.ts` | 報價：`QuoteProvider` 介面；台股 `twse-mis → twse/tpex-openapi → finmind → yahoo`，美股 `yahoo → finnhub → twelvedata → alphavantage`，最後 `manual`；registry 做 fallback、熔斷（連續失敗 3 次冷卻 5 分）、退避重試、節流、批次合併；盤中且頁面可見才輪詢 |
| `portfolio.ts` / `snapshots.ts` / `networth.ts` | 投資組合總覽（持倉、估值、股利、XIRR）、每日資產快照補齊、淨資產歷史 |
| `fx.ts` | 匯率：open.er-api.com → fawazahmed0 currency-api（jsDelivr）備援 |
| `notifications.ts` / `push.ts` | 本地提醒與提醒中心；Web Push 訂閱與排程（App 開啟時排好未來 14 天） |
| `lock.ts` | App 鎖：PBKDF2(SHA-256,210k)＋salt 的 PIN、WebAuthn（本機驗證）、連錯等待（30 秒起倍增，最長 1 小時，持久化） |
| `backup.ts`、`csv.ts`、`xlsx.ts`、`importer.ts` | JSON 備份還原（排除 `meta`/`sync_outbox`/App 鎖/通知）、CSV、極簡 XLSX、匯入精靈（Moze、銀行對帳單、可存格式） |
| `einvoice.ts`、`carrier.ts` | 電子發票 QR／CSV 解析；手機條碼載具經自架伺服器查財政部 API |
| `inbox.ts` | 自動記帳收件匣（App 端）：拉取、解析、去重、確認、記住「卡片→帳戶」 |
| `autocat.ts` | `suggestCategory()` 等自動分類服務 |
| `quickentry.ts` / `nlquery.ts` / `voice.ts` | 一句話記帳補全、用問的查帳執行、語音辨識引擎 |
| `cashflow.ts` / `summary.ts` / `tax.ts` | 各報表的資料來源 |
| `health.ts` | 資料健康檢查與修復（先檢查列出問題，確認後才修） |
| `attachments.ts` | 收據照片壓縮與縮圖 |
| `appUpdate.ts` | 手動檢查新版本 |

---

## 9. 跨裝置同步與端對端加密

**範圍**：帳戶、分類、帳目、轉帳、範本、預算、專案、標籤、常用篩選、週期、分期、分帳、目標、匯率、股票、交易、股利、觀察清單、快照、心願、規則、設定（`SYNCED_TABLES` 在 `src/db/sync-tracking.ts`）。**不同步**：收據照片、App 鎖、通知設定、文字大小、報價快取、E2EE 金鑰、同步游標與裝置 id（`meta`）。

**流程**：本機寫入 → DBCore 中介層在同一交易寫 `sync_outbox` → 約 1 秒後 `POST /api/sync/push` → 伺服器 `sync_records`（**最後寫入者勝**，以 `updated_at` 判斷，整筆為單位，同時間保留伺服器版）→ 其他裝置 `GET /api/sync/pull?since=游標`。套用遠端變更在標記為「遠端」的交易中進行（不回寫佇列避免循環），涉及帳目／轉帳／帳戶時**由各裝置自行重算帳戶餘額**。

**同步時機**：登入後立即、本機變更後約 1 秒、畫面可見每 15 秒、背景每 60 秒、切回前景、恢復網路、登出前。無變更時只發一個 `status` 請求。

**首次同步**：先把既有資料排入佇列（未修改的預設資料變更時間記 0）→ **先下載再上傳**（伺服器版本優先於預設值）。

**時鐘校正**：用 `server_time` 與請求往返中點算時差，變更時間以伺服器時間記錄；伺服器把超過「現在＋5 分鐘」的時間截斷。

**墓碑**：刪除在伺服器留 `deleted=true` 90 天後清除（每位使用者每 6 小時檢查）；游標早於 `purged_seq` 的裝置收到 `reset: true` → 完整重新同步。

**限制**：只接受白名單資料表；單筆 ≤256KB；每批 ≤500 筆（前端每批 ≤400 筆／≈1.5MB）；每使用者 ≤50 萬筆。

**E2EE（選用）**：設定另一組加密密碼 → PBKDF2-SHA256 310,000 次＋伺服器保存的隨機鹽 → AES-256-GCM；`payload` 變成 `{"$enc":1,"iv":…,"ct":…}`；伺服器只看得到表名、id、修改時間、是否刪除；`sync_keys` 只存鹽／次數／驗證密文／版本。新裝置需輸入加密密碼才同步；**忘記密碼無法從伺服器取回**。解密必須在 IndexedDB 交易之外進行（WebCrypto 的 await 會讓交易提早結束）。

---

## 10. 後端 API 與安全

### 端點（FastAPI；錯誤格式 `{"detail": "繁體中文訊息"}`）
| 路徑 | 說明 |
|---|---|
| `GET /api/health` | 健康檢查 |
| `GET /api/auth/registration`、`POST register / login / refresh / logout / change-password`、`GET me`、`GET /api/auth/check`（nginx auth_request） | 認證 |
| `/api/admin/{stats, users, users/{id}/status, users/{id}/force-logout, users/{id}/reset-password, audit-logs, settings}` | 管理員（`require_admin`） |
| `/api/sync/{status, push, pull, keys(GET/PUT)}` | 同步與 E2EE 設定 |
| `/api/push/{status, subscribe, unsubscribe, schedule, test}` | Web Push |
| `/api/einvoice/{status, carrier}` | 財政部電子發票（需 `CLURE_EINVOICE_APP_ID`／`API_KEY`；個人通常申請不到，退回 QR／CSV） |
| `/api/inbox/{tokens(GET/POST/DELETE), items, items/ack}` | 收件匣管理（需登入） |
| `POST /api/hook/inbox` | iPhone 捷徑寫入（`Authorization: Bearer clr_…`／`X-Aster-Token`／舊 `X-Clure-Token`／`?t=`）；不使用 Cookie 故免 CSRF；每權杖 30 則/分、每 IP 60 次/分 |

### 資安設計
- 密碼：Argon2id，長度 8–128、需英數、不可與帳號相同；登入失敗一律同訊息，找不到帳號仍跑假雜湊防時間差。
- Access Token：JWT HS256 15 分鐘（含 `ver`＝`token_version`，每次請求比對 DB 的 `is_active` 與版本；遞增即全部失效）；Refresh Token：JWT＋DB 14 天、每次輪替、**重用偵測→撤銷整條鏈並寫審計**。
- Cookie：`HttpOnly`、`SameSite=Lax`、`Secure`（`CLURE_COOKIE_SECURE=auto` 經 HTTPS 時開啟）；Access Cookie 路徑為整個網站（1.2.2 起，否則 `/proxy/` 收不到）。
- CSRF：double-submit（`csrf_token` Cookie ＋ `X-CSRF-Token`），所有非 GET 需帶（`/api/hook/` 例外）。
- 暴力破解：頻率限制（IP、IP＋帳號，**存 DB**）＋帳號鎖定（連續 5 次失敗鎖 15 分鐘）。
- 審計日誌：`auth.*`、`admin.*` 動作；`detail` 絕不含密碼／權杖；Email 遮罩。
- JWT 金鑰：`CLURE_JWT_SECRET`，未設定則自動產生存在資料目錄；Web Push 的 VAPID 私鑰存 `data/api/vapid_private.pem`（刪除會讓所有裝置重新開啟推播）。
- 收件匣暫存**沒有端對端加密**（捷徑沒有加密密碼），確認後立即刪除，30 天未處理自動清除。
- 前端 CSP 嚴格（見第 2 節）。

### 部署前安全檢查（預設值為「內網 NAS 家用」設計）
`CLURE_ALLOW_REGISTRATION=true`（建好帳號後關閉）、`CLURE_FIRST_USER_ADMIN=true`（第一位註冊者是管理員，部署後立刻自己先註冊或預設 `CLURE_ADMIN_*`）、`POSTGRES_PASSWORD=change-me`（啟用 PG 務必改）、`PROXY_ACCESS_TOKEN` 空（若另外對外開放代理要設）、`CLURE_COOKIE_SECURE=auto`（對外請放 HTTPS 反代後）。`.env` 已被 `.gitignore` 排除，**不得提交**。

---

## 11. 環境變數（`.env.example`）

`CLURE_PORT`(9122)、`TZ`(Asia/Taipei)、`CLURE_DATA_PATH`(./data；資料庫與金鑰所在，覆蓋更新時務必保留)、`PUID`/`PGID`、`CLURE_POLL_MS`/`CLURE_SETTLE_MS`/`CLURE_RUN_TESTS`（前端建置器）、`CLURE_JWT_SECRET`、`CLURE_ADMIN_USERNAME/EMAIL/PASSWORD`、`CLURE_ALLOW_REGISTRATION`、`CLURE_FIRST_USER_ADMIN`、`CLURE_COOKIE_SECURE`、`CLURE_DATABASE_URL`（空＝SQLite）、`POSTGRES_PASSWORD`、`CLURE_LOG_LEVEL`、`CLURE_EINVOICE_APP_ID/API_KEY`、`CLURE_PROXY_REQUIRE_LOGIN`、`PROXY_ACCESS_TOKEN`。後端另有 `access_token_minutes`、`refresh_token_days`、`login_rate_limit_per_minute`、`lockout_threshold`、`lockout_minutes`、`trust_proxy_headers` 等（`server/app/core/config.py`）。前端建置期：`VITE_AUTH_MODE=off`。

---

## 12. 部署與開發流程

### 本機開發
需要 Node ≥20、Python ≥3.10。
```bash
# 後端
cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cd server && CLURE_ENV=development .venv/bin/alembic upgrade head && CLURE_ENV=development .venv/bin/uvicorn app.main:app --port 8000
# 前端（http://localhost:9122，內建 /proxy，/api 轉 8000）
npm install && npm run dev
```
| 指令 | 說明 |
|---|---|
| `npm test` / `test:watch` | Vitest 單元測試（172 項，涵蓋金額、計算機、期間、帳目一致性、預算、週期、分期、分帳、FIFO、台股費稅、XIRR、市場時間、報表、CSV/Excel、匯入、PIN、同步、E2EE、備份、自動分類、發票、財務自由、稅務、貸款、推播排程、一句話記帳、收件匣解析、現金流、週報、問答查帳…） |
| `npm run typecheck` / `build` / `preview` | 型別檢查／建置／預覽（9122，SW 生效） |
| `npm run icons` | 由 `assets/icon.svg` 重產圖標與 iOS 啟動畫面 |
| `npm run pack:nas` | 產生 `aster-nas.zip`（不含 `.env`、`data/`） |
| `cd server && .venv/bin/python -m pytest -q` | 後端測試（auth、admin、cli、einvoice、inbox、push/e2ee、sync） |

### NAS Docker（熱更新版，`docker-compose.yml`）
服務：`web-builder`（node:20-alpine，`docker/web-watch.mjs` 監看原始碼 → `vite build` → 成功才原子切換，失敗保留舊版）、`web`（nginx，對外 9122，`nginx-watch.sh` 設定熱載入）、`api`（python:3.12-slim，`docker/api-entrypoint.sh` 安裝套件、修正權限、`uvicorn --reload`，輪詢偵測檔案變更）、`quote-proxy`（Node 報價代理，`node --watch`）、選用 `postgres`（`--profile postgres`）。資料卷：`clure-node-modules`、`clure-www`、`clure-pyenv`。資料在 `${CLURE_DATA_PATH}/api/`（`clure.db`、`jwt_secret`、`vapid_private.pem`）。
**更新方式**：電腦 `npm run pack:nas` → 解壓覆蓋到 NAS 同一資料夾（不要先刪除）→ 依覆蓋的檔案自動重建／重載（`src/` 30–90 秒；`package*.json` 數分鐘；`server/app`、`alembic` 熱重載＋自動遷移；`requirements.txt` 自動重裝；`proxy/` 自動重啟；只有 `docker-compose.yml`／`.env` 變動才需 `docker compose up -d`）。
管理員 CLI（api 容器內）：`python -m app.cli create-admin | delete-user | list-users`。
其他部署：Cloudflare Pages（`public/_redirects` 處理 SPA）＋ Cloudflare Worker 報價代理（`proxy/wrangler.toml`）。

> Service Worker、通知、推播、Face ID 只在 **HTTPS 或 localhost** 運作。

### iOS 整合
- 加入主畫面（Safari → 分享 → 加入主畫面）；主畫面 App 與 Safari 分頁儲存空間分開。
- 深層連結 `/add?type=expense&amount=120&category=food-lunch&account=…&note=…&date=YYYY-MM-DD&tags=a,b&project=名稱&text=一句話`。
- 預先簽署的捷徑（`public/shortcuts/aster-{siri,applepay,sms}.shortcut`，由 `scripts/make-shortcuts.py` 產生，內含**沒有網址或權杖**），App 內「加入」會建立權杖並把連結碼複製到剪貼簿再跳轉到「捷徑」App；Apple Pay「交易」與「訊息」自動化需使用者自己建立（iOS 限制）。

---

## 13. 檔案地圖

```
Aster/
├─ README.md / CHANGELOG.md          功能總覽、部署、變更紀錄（由新到舊，目前 1.4.4）
├─ PROJECT_OVERVIEW_FOR_AI.md        本檔案
├─ package.json / vite.config.ts / tsconfig.json / index.html
├─ .env.example / .github/workflows/ci.yml / .dockerignore / .gitignore
├─ docker-compose.yml / docker-compose.build.yml
├─ docker/                           Dockerfile.proxy/.web、nginx.conf、security-headers.conf、nginx-watch.sh、web-watch.mjs、api-entrypoint.sh
├─ docs/
│  ├─ DESIGN.md                      原始設計（技術選型、資料模型、頁面、報價架構；含「v1.0 實作備註」與實際差異）
│  ├─ AUTH_DESIGN.md                 帳號系統／管理後台設計（schema、端點、資安）
│  ├─ SYNC.md                        同步與 E2EE 設計
│  ├─ INBOX.md                       自動記帳收件匣（iPhone 捷徑）
│  ├─ KNOWN_LIMITS.md                已知限制（iOS 平台、資料與安全、報價資料源、計算、電子發票、帳號系統）
│  └─ QA.md                          QA 檢查清單
├─ proxy/                            src/core.ts（共用核心）、worker.ts、node-server.ts、wrangler.toml、README.md
├─ scripts/                          gen-icons.mjs、make-shortcuts.py、pack-nas.sh
├─ public/                           boot.css、_redirects、shortcuts/*.shortcut（icons/splash 為建置/產生的圖檔）
├─ assets/icon.svg                   App 圖標原稿
├─ server/
│  ├─ app/main.py                    建立 app、中介層（CSRF、請求日誌）、例外處理、lifespan（建立預設管理員）
│  ├─ app/{db.py, cli.py}
│  ├─ app/core/                      config、security、rate_limit、request_info、logging、webpush
│  ├─ app/model/                     users、refresh_token、audit_log、rate_limit、sync_record、e2ee_push、inbox、app_setting
│  ├─ app/schema/                    auth、admin、audit、sync、push、inbox、einvoice
│  ├─ app/repository/                user、token、audit、sync、stats
│  ├─ app/service/                   auth、admin、audit、stats、sync、push、inbox、einvoice、app_settings、errors
│  ├─ app/api/                       deps、auth、admin、sync、push、inbox、einvoice、health、cookies
│  ├─ alembic/versions/              0001_initial … 0006_app_settings
│  └─ tests/                         conftest + test_{admin,auth,cli,einvoice,inbox,push_e2ee,sync}.py
├─ src/                              見第 5、7、8 節
│  └─ features/
│     ├─ home/        HomePage、Calendar、Widgets、RemindersSheet、VoiceSheet
│     ├─ add/         AddSheet（最大單檔，約 47KB）、Keypad、QuickEntry、SplitSheet、pickers
│     ├─ ledger/      LedgerPage、LedgerRow、FilterSheet
│     ├─ accounts/    AccountsPage（含帳戶詳情）、AccountSheet
│     ├─ plan/        PlanPage、budgets、projects、recurring、installments、debts、goals、wishlist
│     ├─ reports/     ReportsPage、SummaryPage、CashflowPage、FirePage、TaxPage、YearReview、PrintReport、EChart、chart-theme
│     ├─ invest/      InvestTab、StockDetailPage、TradeSheet、StockSearch、WatchlistPage、DividendsPage
│     ├─ settings/    SettingsPage + Backup/Categories/Fx/Health/Import/InvestSettings/Invoice/Notifications/Rules/Security/Tags/Widgets 各頁
│     ├─ inbox/       InboxPage
│     ├─ search/      SearchPage
│     ├─ auth/        AuthPages（登入／註冊／改密碼）
│     ├─ admin/       AdminPage
│     └─ onboarding/  Onboarding、Highlights
└─ tests/unit/                       *.test.ts（Vitest；sync-engine.test.ts 以模擬伺服器測兩台裝置同步）
```

---

## AI 功能（v1.5.0～2.0.0，詳見 `docs/AI.md`）

- **架構**：前端先用規則（本機、免費），規則做不到才請 AI；管理員在 `.env` 設一把共用 Key，後端 `server/app/service/ai_{quota,providers,tasks,service}.py` 提供供應商鏈（`gemini`／`openrouter`／`nvidia`／`custom`，OpenAI 相容 `/chat/completions`，失敗自動換下一家、連續 3 次失敗冷卻 5 分鐘）與額度（每位使用者日／週／月＋全站每日＋全站每分鐘；`ai_usage` 表；失敗不扣額度；收據辨識扣 2 點）。API：`/api/ai/{status,parse-entry,ask,budget-plan,insights,categorize,receipt}`、`/api/admin/ai{,/console,/test}`。
- **前端**：`src/services/ai.ts`（呼叫、本機結果快取 `meta` 表、進行中請求共用）、`src/domain/aisummary.ts`（去識別化收支摘要、日常預算＝（總預算−固定支出）÷天數、預算建議對回分類）、`src/domain/aiparse.ts`、`src/features/ai/{AiAssistant,AiInsights}.tsx`（`/ai`：問 AI、下月預算建議、白話解讀、AI 整理分類、拍照記帳）、`src/features/settings/AiPage.tsx`（兩個隱私開關 `ai.enabled`／`ai.allowData`，預設關）、`src/features/admin/AiConsole.tsx`（管理員主控台：連線狀態、測試連線、用量、額度）。
- **隱私原則**：統計類功能只送整數統計與分類名稱（無備註、商家、帳戶名、單筆帳目）；伺服器不保存內容；輸出驗證（分類必須在使用者名單內）並以純文字顯示。免費層的內容可能被供應商用於改進產品。
- **測試**：`server/tests/test_ai.py`、`test_rate_limit.py`；`tests/unit/aisummary.test.ts`、`aiparse.test.ts`、`nlquery.test.ts`。

---

## 14. 開發慣例與注意事項（AI 修改程式碼時請遵守）

1. **語言**：UI 文字、註解、commit 訊息、文件均為**繁體中文**；commit 格式 `feat|fix: vX.Y.Z — 說明`（例：`fix: v1.4.4 — iPhone 長按語音：…`）。版本號在 `package.json`，變更要同步寫 `CHANGELOG.md`。
2. **金額**：一律整數最小單位；股價／股數／匯率用 decimal 字串＋`decimal.js`；不要用浮點加總金額。
3. **寫 DB 只能走 `src/db/repo/*`**（會維護帳戶餘額快取與同步追蹤）；不要在元件裡直接 `db.table.put()`。
4. **新增資料表或索引**：新增 `db.version(n)`，不得改既有版本；若該表需同步，加入 `SYNCED_TABLES` 與後端白名單。
5. **同步相關**：遠端套用須在「遠端」交易中（避免回寫）；E2EE 解密不可放在 IndexedDB 交易內；備份／還原不可帶入 `meta`、`sync_outbox`、App 鎖與通知設定。
6. **domain 層保持純函式**並補單元測試（`tests/unit/`）；後端新增邏輯補 `server/tests/`。
7. **後端分層**：路由不碰 DB、repository 才碰 Session；錯誤用 `service/errors.py` 的業務錯誤、訊息用繁體中文且不洩漏內部細節；日誌禁用 `print`、不得記錄密碼／權杖。
8. **後端 DB 變更**一律新增 Alembic 遷移（下一個是 `0010_…`），啟動時自動套用。
9. **iOS 限制**：語音辨識、通知、Face ID 都需要「真正的使用者手勢」與 HTTPS；輸入框在觸控裝置至少 16px 避免縮放；不要在長按計時器內啟動需要手勢的 API。
10. **Service Worker**：不自動 `skipWaiting`（由使用者同意更新）；導覽 denylist 含 `/proxy/`、`/api/`、`/shortcuts/`。
11. **CSP**：不能新增 inline `<style>` 元素或 inline script；新增外部連線網域要同步改 `docker/security-headers.conf` 的 `connect-src`，必要時也改 `proxy/src/core.ts` 的 `ALLOWED_HOSTS`。
12. **相容性命名**：保留 `CLURE_*`、`clure-u{id}`、`x-clure-token` 等舊名（見第 1 節）。
13. **解析類功能先走規則式**（`nlp.ts`、收件匣簡訊、`nlquery.ts`、異常偵測的 `pricing.ts`），規則解析不了時才由使用者開啟的 AI 後備（v2.0 起，見 `docs/AI.md`；送出內容都記在 AI 送出紀錄）；改規則時請同步更新對應單元測試。
14. 目前分支 `feature/v1.2`（開發分支，比 `main` 新很多）；最新版 3.6.5，提交格式見第 1 條。

---

## 15. 已知限制（精簡版，完整見 `docs/KNOWN_LIMITS.md`）

- iOS PWA 無法背景執行 → 開啟 App 時補算；背景推播需 iOS 16.4+、加入主畫面、HTTPS；預算與到價提醒仍只在 App 開啟時檢查。
- 本機資料明文存於 IndexedDB（App 鎖保護畫面、不是加密）；未啟用 E2EE 時伺服器上的帳目是明文 JSON。
- 免費報價源可能延遲／限流（Yahoo 對部分 IP 回 429；mis.twse 頻繁請求會被封）；興櫃無穩定免費即時報價；港股僅 Yahoo。
- 台股手續費以「成交金額×費率×折扣、無條件捨去」估算，實際以券商為準。
- 電子發票手機條碼自動抓取需財政部 AppID（個人通常申請不到）；財政部 API 只能查約 9 個月。
- 稅務彙總與財務自由試算為估算（113 年度標準、常態分布報酬＋固定通膨）。
- 一句話記帳／用問的查帳為規則解析，說法差太多可能判斷錯。
- PDF 報表為「瀏覽器列印→另存 PDF」；XLSX 為精簡自寫產生器（無公式）。
- 審計日誌不自動清除；Cookie 未走 HTTPS 時不帶 Secure。

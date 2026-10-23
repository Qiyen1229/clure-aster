# Clure 記帳（PWA）

自架的個人記帳＋股票投資組合 PWA：帳目存在你自己的伺服器（NAS），同一個帳號在手機、平板、電腦之間自動同步，離線也能記帳。參考 Moze 4.0 的操作邏輯，iOS 原生質感，可加入 iPhone 主畫面。

- 設計文件：[docs/DESIGN.md](docs/DESIGN.md)
- QA 檢查清單：[docs/QA.md](docs/QA.md)
- 已知限制：[docs/KNOWN_LIMITS.md](docs/KNOWN_LIMITS.md)
- 報價代理部署：[proxy/README.md](proxy/README.md)

> **進度：階段 1–5 ＋ v1.1（帳號系統、管理員資安後台、信用額度、股利行事曆、今日可用、心願清單）完成 ✅**

- 帳號系統設計：[docs/AUTH_DESIGN.md](docs/AUTH_DESIGN.md)　跨裝置同步設計：[docs/SYNC.md](docs/SYNC.md)

---

## 功能總覽

| 階段 | 功能 |
|---|---|
| 1 記帳核心 | PWA（離線、更新提示、主畫面、啟動畫面）、深淺色＋8 主題色、紅漲綠跌切換、記帳月曆、計算機鍵盤、支出／收入／轉帳（含手續費、跨幣別）／餘額調整、兩層分類、標籤、收據照片、語音備註、範本、複製上一筆、再記一筆、帳目列表（虛擬捲動、左滑刪除＋復原、右滑編輯、長按選單、批次操作）、多帳戶與信用卡帳單、首次引導、範例資料 |
| 2 規劃 | 預算（月／週／自訂天數、總額／分類／專案、結轉、每日可用、超支推估與警示）、專案／旅行（獨立幣別、預算、統計、匯出）、進階篩選＋常用篩選、週期帳目與訂閱（自動入帳或待確認、續約提醒、年度訂閱總花費、價格紀錄）、分期（0 利率／本息平均、手續費首期或分攤、攤還表、未來負擔）、分帳 AA（帳戶扣全額、統計只算我的份額、誰欠我／我欠誰、結清入帳）、應收／應付帳款（記一筆直接選「應收／應付」；借出／借入動帳戶但不計入收支與預算）、存錢目標（連結帳戶、環形進度、每月需存）、匯率管理（自動更新＋手動覆蓋） |
| 3 報表 | 摘要指標（儲蓄率、收支比、日均、最大單筆、最常花錢的星期／時段）、分類環形圖（下鑽子分類、點擊看明細）、每日／每月趨勢、近 12 個月、淨資產成長曲線、本月 vs 上月／去年同月、帳戶／專案／標籤／幣別篩選、年度回顧（Wrapped 風格）、可列印 PDF 報表、首頁小工具（可排序） |
| 4 投資 | 股票搜尋（台股上市／上櫃／興櫃／ETF、美股、港股）、買進／賣出／配股／分割、整股／零股、台股手續費（折扣、最低）與證交稅自動計算、加權平均／FIFO、已實現／未實現、今日損益、總報酬率（含股利）、XIRR、若今天賣出淨損益、外幣股價損益與匯差拆分、股利（現金／配股、預扣稅、二代健保、自動入帳）、成本／現價殖利率、配置圓餅（個股／產業／市場／幣別）、市值與損益曲線（每日快照、自動補齊）、個股走勢 1D–ALL、損益排行、觀察清單與到價提醒、可插拔資料源自動 fallback、盤中自動刷新、離線顯示最後價格、手動輸入現價、記帳同步 |
| 5 系統 | 提醒（每日記帳、信用卡繳款、預算、訂閱、到價、備份）＋提醒中心、App 鎖（PIN＋Face ID／Touch ID）、背景模糊、隱藏金額、JSON 完整備份／還原（含照片）、CSV／Excel 匯出、PDF 報表、CSV 匯入精靈（自動辨識 Moze）、資料健康檢查與修復、iOS 捷徑深層連結、桌機快速鍵 |

---

## v1.1 新功能

| 功能 | 說明 |
|---|---|
| 信用卡額度佔用 | 帳戶詳情：剩餘可用額度 = 總額度 − 目前欠款（已出帳未繳＋未出帳）− 未到期分期本金，含佔用比例條與使用率 |
| 股利行事曆 | 股利頁：1～12 月「已領／預估」堆疊長條圖；預估 = 去年同月每股股利 × 目前持股，已公告者以公告金額計 |
| 今日可用（動態每日額度） | 今日額度 = 今天開始前的剩餘預算 ÷ 剩餘天數（含今天）；今天少花明天自動變多、超支則變少。首頁小工具與預算卡大字顯示 |
| 心願清單 | 專案與預算 → 心願：冷靜期 3／7／14／30 天，到期提醒「你還想買嗎？」，放棄購買會累計「冷靜期幫你省下」 |
| 帳號系統 | 註冊／登入（帳號或 Email）、Argon2id、JWT（HttpOnly Cookie）、Refresh 輪替與重用偵測、CSRF、頻率限制、帳號鎖定 |
| 管理員資安後台 | `/admin`：系統總覽、使用者管理（凍結／啟用、強制登出、重設密碼）、資安審計日誌 |
| 本機資料隔離 | 每個帳號獨立的 IndexedDB；首次登入可把舊資料歸到帳號；離線時曾登入的裝置可繼續使用 |
| 跨裝置同步 | 帳目、分類、預算、投資、設定自動同步到自架伺服器；新裝置登入直接取得全部資料（不再出現首次設定）；變更約 1 秒內上傳，其他裝置 15 秒內收到（背景 60 秒）；離線記的帳恢復連線後自動上傳；同一筆兩邊都改時以較晚的修改為準。設定 → 帳號 → 跨裝置同步 可看狀態、立即同步 |
| 動態效果 | 頁面依方向滑入（分頁左右、進入／返回下一層）、清單與卡片依序進場、按鈕按壓回彈、選取時彈跳、Tab 圖示彈跳＋指示點；尊重系統「減少動態效果」 |

---

## 本機執行

需要 Node.js 20 以上（報價代理容器使用 Node 22），後端需要 Python 3.10 以上。

後端（另開一個終端機）：

```bash
cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
```

```bash
cd server && CLURE_ENV=development .venv/bin/alembic upgrade head && CLURE_ENV=development .venv/bin/uvicorn app.main:app --port 8000
```

前端：

```bash
npm install
```

```bash
npm run dev
```

開啟 **http://localhost:9122**。開發伺服器已內建 `/proxy` 報價代理，並把 `/api` 轉給本機 8000 埠的後端。全新系統的第一位註冊者會成為管理員。

後端測試：

```bash
cd server && .venv/bin/python -m pytest -q
```

不想啟用帳號系統（回到純本機模式）：建置時設定 `VITE_AUTH_MODE=off`。

| 指令 | 說明 |
|---|---|
| `npm test` | 前端單元測試（97 項：金額、計算機、期間、帳目與餘額一致性、預算、週期、分期、分帳、平均成本、FIFO、台股費稅、XIRR、市場時間、報表、CSV／Excel、Moze 匯入、PIN、「其他」子分類、應收應付、同步變更追蹤、兩台裝置同步） |
| `npm run build` | 型別檢查＋正式建置到 `dist/` |
| `npm run preview` | 以正式建置在 http://localhost:9122 預覽（Service Worker 生效、含 `/proxy`） |
| `npm run icons` | 由 `assets/icon.svg` 重新產生所有圖標與 iOS 啟動畫面 |

---

## ⚠️ 部署前請先檢查（安全提醒）

預設設定是為「自架在內網 NAS、只給自己和家人使用」設計的。若你要放到公網或給陌生人使用，請先改掉下列項目：

| 項目 | 預設值 | 建議 |
|---|---|---|
| `CLURE_ALLOW_REGISTRATION` | `true`（開放註冊） | 建好自己的帳號後改成 `false`，避免陌生人註冊 |
| `CLURE_FIRST_USER_ADMIN` | `true`（第一位註冊者是管理員） | 部署後第一時間自己先註冊，或預先設定 `CLURE_ADMIN_*` |
| `POSTGRES_PASSWORD` | `change-me` | 若啟用 PostgreSQL，**務必**改成強密碼 |
| `PROXY_ACCESS_TOKEN` | 空（不驗證） | 對外開放報價代理時請設定一串隨機權杖 |
| `CLURE_COOKIE_SECURE` | `auto` | 對外服務請放在 HTTPS 反向代理後面 |

另外：

- `.env` 已被 `.gitignore` 排除，**請勿把自己的 `.env` 提交到 Git**。
- `clure-nas.zip`／`clure-nas.tar.gz` 這類打包檔內含 `.env` 副本，也已排除，請勿上傳。
- 發現安全問題請開 Issue（不要貼出密鑰或個資）。

---

## NAS Docker 部署（掛載＋熱更新：覆蓋檔案即自動更新）

| 檔案 | 用途 |
|---|---|
| `docker-compose.yml` | **預設**。原始碼以 Volume 掛載：`web-builder`（自動建置前端）＋ `web`（nginx，對外 9122）＋ `api`（FastAPI 熱重載）＋ `quote-proxy`（報價代理）＋ 選用 `postgres` |
| `docker/web-watch.mjs` | 前端建置器：監看原始碼 → `vite build` → 成功才整個切換（失敗保留舊版） |
| `docker/api-entrypoint.sh` | 後端啟動腳本：安裝套件、修正資料夾權限、`uvicorn --reload`；`requirements.txt` 變更時自動重裝 |
| `docker/nginx.conf` | 9122、SPA fallback、SW 不快取、資產長快取、gzip、`/api/`、`/proxy/` 同源轉發、`/healthz` |
| `docker/security-headers.conf` | CSP 與安全標頭 |
| `.env.example` | 埠號、資料位置、PUID／PGID、帳號系統設定 |
| `docker-compose.build.yml` | （選用）舊的映像檔版本：每次更新需 `--build` 重建，適合不想讓容器讀原始碼的情境 |

### 第一次部署

1. 把整個專案資料夾放到 NAS（例如 `/volume1/docker/clure`）。不需要上傳 `node_modules`、`dist`、`server/.venv`。
2. `cp .env.example .env`，建議設定：
   - `PUID`／`PGID`：NAS 上擁有這個資料夾的使用者（Synology 通常是 `1026`／`100`，在 NAS 終端機執行 `id` 可查）
   - `CLURE_DATA_PATH`：資料庫存放位置，**建議放在專案資料夾外**，例如 `/volume1/docker/clure-data`
   - `CLURE_JWT_SECRET`（`openssl rand -base64 64` 產生）
   - `CLURE_ADMIN_USERNAME`／`CLURE_ADMIN_EMAIL`／`CLURE_ADMIN_PASSWORD`（首次啟動建立管理員），並把 `CLURE_FIRST_USER_ADMIN` 設為 `false`
   - 只給家人使用時，建好帳號後把 `CLURE_ALLOW_REGISTRATION` 設為 `false`
3. 在該資料夾執行（或在 Container Manager「專案」中用這個資料夾建立專案）：

```bash
docker compose up -d
```

4. 第一次啟動會安裝套件並建置前端，約需數分鐘。可用下面的指令看進度，出現「✅ 已上線」後開啟 `http://<NAS-IP>:9122`。

```bash
docker compose logs -f web-builder api
```

### 之後更新版本：直接拖曳覆蓋

把新版檔案**覆蓋**到同一個資料夾即可，不必刪除資料夾、不必刪除或重建 Docker 專案：

| 你覆蓋的檔案 | 自動發生的事 | 大約時間 |
|---|---|---|
| `src/`、`public/`、`index.html`、`vite.config.ts` | web-builder 偵測到變更 → 等上傳完成（靜止 4 秒）→ 重新建置 → 切換新版 | 30–90 秒 |
| `package.json`／`package-lock.json` | 先重新安裝前端套件再建置 | 數分鐘 |
| `server/app/`、`server/alembic/` | uvicorn 熱重載；有新的資料庫遷移會自動套用 | 數秒 |
| `server/requirements.txt` | 自動重新安裝 Python 套件並重啟 API | 1–2 分鐘 |
| `proxy/` | `node --watch` 自動重啟報價代理 | 數秒 |
| `docker/nginx.conf`、`docker-compose.yml`、`.env` | 需手動套用：`docker compose up -d`（nginx 設定則 `docker compose restart web`） | — |

- 建置失敗（例如檔案只傳了一半）會**保留舊版本繼續服務**，修正後自動重試；原因可在 `docker compose logs web-builder` 看到。
- 前端更新後，已開啟的 App 會出現「有新版本，點擊更新」。
- 想在建置前先跑單元測試再上線：`.env` 設定 `CLURE_RUN_TESTS=true`。
- ⚠ 覆蓋時**不要刪除** `CLURE_DATA_PATH` 指向的資料夾（預設 `./data`），裡面是資料庫與 JWT 金鑰。

### 其他說明

- 管理員指令（在 api 容器內執行，皆會寫入審計日誌）：
  - 建立／提升管理員：`docker compose exec api /opt/venv/bin/python -m app.cli create-admin --username admin --email you@example.com`（互動輸入密碼；或以環境變數 `CLURE_NEW_PASSWORD` 提供）
  - 刪除使用者：`docker compose exec api /opt/venv/bin/python -m app.cli delete-user --username olduser`（不能刪除最後一位管理員）
  - 列出使用者：`docker compose exec api /opt/venv/bin/python -m app.cli list-users`
- 使用 PostgreSQL：`.env` 設定 `CLURE_DATABASE_URL=postgresql+psycopg://clure:密碼@postgres:5432/clure`，啟動時加 `--profile postgres`；資料存在 `CLURE_DATA_PATH/postgres`。
- 資料備份：備份 `CLURE_DATA_PATH` 整個資料夾即可（SQLite 資料庫含所有帳號與同步的帳目）。
- 若有設定 `PROXY_ACCESS_TOKEN`，到 App「設定 → 股票資料源與 API Key → 代理權杖」填入同樣的值。
- HTTPS 請用你的反向代理／Cloudflare 指向這個埠（Cookie 會自動加上 Secure）。

### 從舊版（映像檔版）換到熱更新版

舊版的資料存在 Docker 資料卷 `clure_clure-data`。第一次換版前，先把資料複製到新的資料夾（以預設 `./data` 為例，在專案資料夾執行）：

```bash
docker compose -f docker-compose.build.yml down
```

```bash
mkdir -p data/api && docker run --rm -v clure_clure-data:/from -v "$(pwd)/data/api":/to alpine cp -a /from/. /to/
```

之後再 `docker compose up -d`。確認帳號都能登入後，舊資料卷可用 `docker volume rm clure_clure-data` 刪除。

> Service Worker（離線）、系統通知、Face ID 只在 **HTTPS** 或 `localhost` 下運作。

### 其他部署方式（Cloudflare Pages）
建置指令 `npm run build`，輸出目錄 `dist`（`public/_redirects` 已處理 SPA 路由）。報價代理改用 Cloudflare Worker，步驟見 [proxy/README.md](proxy/README.md)，並把 Worker 網址填到 App 設定。

---

## 在 iPhone 加入主畫面

1. 用 **Safari** 開啟 App 網址（建議 HTTPS）。
2. 點「分享」→「加入主畫面」→「加入」。
3. 從主畫面圖示開啟（全螢幕、有啟動畫面）。
4. 想要系統通知：iOS 16.4 以上，從主畫面開啟後到「設定 → 通知與提醒 → 允許通知」。

> 主畫面 App 與 Safari 分頁的資料是**分開**的（iOS 設計）。請固定在主畫面 App 使用，並定期「設定 → 備份、匯入與匯出 → 匯出備份檔」。

---

## iOS 捷徑（Shortcuts）與深層連結

```
https://你的網址/add?type=expense&amount=120&category=food-lunch&note=便當&tags=固定支出,發票&project=日本旅行
```

| 參數 | 說明 |
|---|---|
| `type` | `expense`（預設）／`income`／`transfer`／`adjust` |
| `amount` | 金額，可含運算式，例如 `100+20` |
| `category` | `food`、`food-lunch`、`transport-mrt`、`salary`…、完整 id（`exp-food`）或中文名稱（`午餐`） |
| `account` | 帳戶 id（帳戶詳情頁網址最後一段） |
| `note` | 備註 |
| `date` | `YYYY-MM-DD` |
| `tags` | 標籤名稱或 id，以逗號分隔；不存在的名稱會自動建立 |
| `project` | 專案名稱或 id（需已存在） |

建立捷徑：捷徑 App →「＋」→「要求輸入（數字）」→「打開 URL」，URL 填 `https://你的網址/add?amount=` 加上「提供的輸入」→ 加到主畫面或用 Siri 呼叫。

其他路徑：`/accounts?tab=invest`（投資）、`/ledger`（帳目）、`/reports`（報表）、`/plan?tab=budget`（預算）。

---

## 桌機快速鍵

| 鍵 | 動作 |
|---|---|
| `N` | 記一筆 |
| `⌘K`／`Ctrl+K`／`/` | 搜尋 |
| `1`–`5` | 帳戶／專案／記帳／報表／設定 |
| `L` | 帳目列表 |
| 記帳面板中 | 數字、`+ - * /`、`Backspace`、`Enter`（完成） |

---

## 專案結構

```
src/
  domain/        純函式（全部有單元測試）：money、calc-expr、period、ledger、budget、recurrence、
                 installment、debt、goal、reports、creditcard、invest/{position,fees-tw,xirr,market-hours}
  db/            Dexie schema、types、repo（ledger、accounts、categories、plan、invest、settings）、seed
  services/      fx、quotes/{http,providers,registry,search}、portfolio、snapshots、networth、startup、
                 notifications、lock、backup、csv、xlsx、importer、health、attachments
  features/      home、add、ledger、accounts、plan、reports、invest、settings、search、onboarding
  ui/ app/ theme/ i18n/ stores/
proxy/           報價代理核心＋Cloudflare Worker＋Node 入口
docker/          Dockerfile、nginx 設定
tests/unit/      Vitest
```

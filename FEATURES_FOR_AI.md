# Aster 記帳 — 功能說明書（給 AI 閱讀）

> 目的：讓接手的 AI（或新開發者）**不用逐檔翻程式碼**就知道「這個 App 能做什麼、每個功能怎麼運作、規則是什麼、程式在哪」。
> 與 [PROJECT_OVERVIEW_FOR_AI.md](PROJECT_OVERVIEW_FOR_AI.md)（技術棧、架構、部署、檔案地圖）互補：那份偏「怎麼建」，這份偏「做了什麼」。
> 版本：**4.0.4**（2026-11-05）。分支 `feature/v1.2`。逐版細節見 [CHANGELOG.md](CHANGELOG.md)；設計文件見 `docs/`。
> 慣例：金額內部一律用**整數最小單位**（TWD 的 1 元 = 100），不要用浮點數；使用者可見文字一律**繁體中文（台灣用語）**。

---

## 0. 一分鐘認識

**Aster 記帳**是自架的個人記帳＋股票投資組合 **PWA**：

- 資料存在使用者自己的伺服器（Synology NAS 上的 Docker），同一帳號在手機／平板／電腦間自動同步，**離線也能記帳**。
- 前端：React 18 + TypeScript + Vite + Dexie（IndexedDB）+ Zustand；後端：FastAPI + SQLAlchemy（SQLite，可換 PostgreSQL）；另有報價代理 `proxy/`。
- 操作邏輯參考 Moze 4.0，iOS 原生質感，可加入 iPhone 主畫面（底部「靈動島」玻璃導覽列）。
- **本機優先**：所有帳目先寫進本機 IndexedDB，再背景同步到伺服器；多數「聰明」功能（解析、偵測、預警、統計）都是**本機規則運算，不呼叫 AI、不花額度**。AI 只在規則做不到、且使用者主動開啟時才用。

### 底部五個分頁（靈動島導覽列）
帳戶（錢包／投資）｜專案與預算（`/plan`）｜**首頁（中央＋按鈕）**｜報表｜設定。中央按鈕在首頁與帳目列表顯示「＋」（點＝記一筆；**長按＝語音記帳**），其他頁顯示 Logo（回首頁）。

---

## 1. 基礎功能（每天都在用）

### 1.1 記一筆（`features/add/AddSheet.tsx`）
- **四種類型**：支出、收入、轉帳（可含手續費、跨幣別）、餘額調整；另有「應收／應付」。
- **計算機鍵盤**：`domain/calc-expr.ts`（**不用 `eval`**），可直接輸入 `120+80*2`。
- **兩層分類**、標籤、專案、收據照片（縮圖存本機，不同步原圖以外的機密）、備註、語音備註、日期與時間。
- **帳戶**：現金、銀行、信用卡、電子支付、投資等；多幣別帳戶，跨幣別記帳可填匯率或轉入金額。
- **快速帶入**：「複製上一筆」、備註欄「最近常記」（一點帶入金額＋分類＋帳戶）、再記一筆開關、自動分類（規則＋商家記憶，見 §3.4）。
- **耐用品標記**（支出才有）：選「預計使用 N 年」或「自訂期限…」（彈窗輸入年＋月），存檔時同時建立一筆耐用品（見 §3.6）。
- **不計入預算**（v3.10.3，支出才有）：勾選後 `excludeFromBudget = true`——**預算進度與「今日還可花」都不算這筆**，但收支統計與報表仍計入；編輯時可取消。
- **分帳 AA**：帳戶扣全額、統計只算「我的份額」；支援「我先付」與「別人先付」（別人先付只記一筆我欠的份額，還款時才記為支出）、事後結清。
- **深層連結** `/add?type=&amount=&category=&account=&note=&date=&tags=&project=&text=`，給 iOS 捷徑用。

### 1.2 一句話／語音記帳（`domain/nlp*.ts`、`services/voice.ts`、`features/home/VoiceSheet.tsx`）
- **純規則解析，不經任何 AI**：金額（「兩千三」「5萬2」「1,200」）、日期（「昨天」「上週五」「10/25」）、帳戶、分類、一次多筆；電話、連續 9 碼以上數字、網址不會被當成金額。
- 長按導覽列中間按鈕：Android／桌機「按住說話、放開入帳」；**iPhone 因 iOS 限制**（只認真正的點擊為使用者手勢）改為放開後彈窗、點麥克風才開始說話。
- 解析檔拆成 `nlp-amount.ts`、`nlp-date.ts`、`nlp-entities.ts`、`nlp.ts`（舊匯入路徑不變）。

### 1.3 首頁（`features/home/`）— 「一個畫面一個重點」
- **主角**：選取日所在「記帳月」的總支出（大數字）＋結餘；若該月有總預算（沒有指定分類的那個）顯示「**今日還可花**」，否則顯示日均。**今日還可花顏色：正數紅色、負數綠色**（依使用者要求，與一般習慣相反，首頁／預算頁／小工具一致）。
- **膠囊週曆**（預設一週，可平滑展開為整月：容器高度 WAAPI＋舊畫面殘影＋整列對齊滑動）；每天顯示小光點／金額；左上角「2026 年 10 月」點開**月份選擇器**。
- **當日**：一行標題（日期＋支出／收入）＋帳目清單（左滑刪除可復原、右滑編輯、長按選單）；「全部 ›」進帳目列表。
- **下半部獨立區塊「提醒與快覽」**（v3.10.3 起，與上半部的收支／日曆／帳目分開，沒內容整塊隱藏）：
  - 「需要你看一下」一張卡，依重要性最多 4 行：📥 收件匣待確認、🔔/⚠️ 預算預警與超支、🔎 異常／疑似重複、✨ AI 上週重點（選用、可收合）。**只讀快取**，快取在帳目變動 ~1 秒後自動重算（見 §3.2）。
- 頂部：AI 小圓球（開啟 AI 對話）、搜尋、提醒中心（鈴鐺，未讀徽章）。

### 1.4 帳目列表（`features/ledger/`）
虛擬捲動、進階篩選＋常用篩選、批次操作（刪除、改分類／標籤／帳戶）、軟刪除＋「復原」、長按選單。

### 1.5 帳戶（`features/accounts/`）
- 多帳戶、淨資產計入開關、封存、初始餘額；**餘額由帳目重算保持一致**（`db/repo/accounts.ts` 的 `bump`/`txEffect`，改動帳目時先扣舊影響再加新影響）。
- **信用卡**：結帳日／繳款日、帳單週期（已出帳未繳＋未出帳）、**額度佔用**（剩餘可用額度 = 總額度 − 欠款 − 未到期分期本金）、使用率條。
- **貸款攤還**（本息平均／本金平均）、淨資產與成長曲線。

### 1.6 預算（`features/plan/budgets.tsx`、`domain/budget.ts`、`db/repo/plan.ts`）
- **期間**：月（依「每月起算日」）、週、自訂天數；範圍：**總預算／分類／專案**；可**結轉**（上期結餘可為負，吃掉下期額度）。
- **今日額度（動態每日可用，Moze 式）**：今日額度 = 今天開始前的剩餘預算 ÷ 剩餘天數（含今天），整天固定；今天少花，省下的平攤到之後每天；超支則之後每天額度減少。`todayLeft = todayBudget − 今天已花`。
- **不算進預算的帳目**：`excludeFromStats`、`excludeFromBudget`、已刪除、非支出／手續費、借貸／投資類系統帳目（`sys-*`）。
- **預估期末花費**：有歷史就用「已花 + 過去 3 期在同一天之後平均又花多少」，否則用目前速度；另有「依過去 3 個完整月份建立預算」建議。
- 預警等級 `ok / warn / over`（預設 80% 警示）。

### 1.7 報表（`features/reports/`）
摘要指標（儲蓄率、收支比、日均、最大單筆、最常花錢的星期／時段）、分類環形圖（下鑽子分類、點擊看明細）、每日／每月趨勢、近 12 個月、淨資產曲線、本月 vs 上月／去年同月、帳戶／專案／標籤／幣別篩選、**年度回顧**（`/reports/review/:year`，Wrapped 風格）、**可列印 PDF**（`/reports/print`）、**週報／月報**（`/reports/summary`）、**資金流向桑基圖**（§3.5）。報表統計一律用 `countsInStats`／`statAmount`（尊重 `excludeFromStats` 與分帳份額）。

### 1.8 規劃類功能（`features/plan/`）
- **專案／旅行**：獨立幣別、預算、統計、匯出。
- **週期帳目與訂閱**：自動入帳或「待確認」、續約提醒、價格紀錄（漲價偵測用）、年度訂閱總花費。
- **分期**：0 利率／本息平均、手續費首期或分攤、攤還表。
- **應收／應付**：借出／借入動帳戶但**不計入收支與預算**。
- **存錢目標**、**心願清單**（冷靜期 3／7／14／30 天，到期問「你還想買嗎？」，放棄會累計「冷靜期幫你省下」）、**耐用品**（§3.6）。
- 匯率管理：自動更新＋手動覆蓋（`services/fx.ts`）。

### 1.9 搜尋（`features/search/`）
全文搜尋（桌機 `⌘K`／`/`）；「**用問的查帳**」（`domain/nlquery.ts`，規則式：「上個月吃飯花多少」）；搜尋不到或輸入長句時可「用 AI 找」（AI 只把句子轉成搜尋條件，再用本機搜尋執行）。

### 1.10 設定（七組：帳號、外觀、記帳偏好、分類與規則、自動化與整合、資料、關於）
深淺色＋8 主題色、文字大小、紅漲綠跌切換、基準幣別、分類與標籤管理、自動分類規則、App 鎖（PIN＋Face ID／Touch ID，WebAuthn 於本機用 WebCrypto 驗證）、背景模糊、隱藏金額、備份／還原、匯入、資料健康檢查、通知、外部通知、AI 助理（磚塊圖示 40px）。

---

## 2. 投資組合（階段 4，`features/invest/`、`domain/invest/`、`services/quotes/`）
- **標的**：台股（上市／上櫃／興櫃／ETF）、美股、港股；買進／賣出／配股／分割、整股／零股。
- **台股手續費**（折扣、最低手續費）與**證交稅**自動計算；成本法：加權平均／FIFO。
- **績效**：已實現／未實現、今日損益、總報酬率（含股利）、**XIRR**、「若今天賣出」淨損益、外幣股價損益與匯差拆分。
- **股利**：現金／配股、預扣稅、二代健保、自動入帳；**股利行事曆**（1～12 月已領／預估堆疊圖，預估 = 去年同月每股股利 × 目前持股）。
- **視覺**：配置圓餅（個股／產業／市場／幣別）、市值與損益曲線（每日快照 `services/snapshots.ts`、自動補齊）、個股走勢 1D–ALL、損益排行。
- **觀察清單與到價提醒**（`db/repo/invest.ts` 的 `checkPriceAlerts`；提醒只在 App 開啟／報價更新時檢查）：**只在「穿越」條件的那一刻通知一次**——例如「台積電跌破 2300」，跌破時通知，之後一直在 2300 以下不再通知；要先站回 2300 以上（重新武裝），再次跌破才會再通知。每個提醒存 `triggered` 狀態（舊資料有 `lastTriggeredAt` 視為已觸發），每次穿越的通知 id 都不同，同一天重複穿越也不會被去重吃掉。
- **報價資料源**：可插拔多來源，自動 fallback＋熔斷；盤中自動刷新；經 `proxy/` 報價代理（NAS 上容器 `clure-quote-proxy`，nginx `/proxy`）。
- **稅務彙總**（`/reports/tax`）：合併／分開計稅、二代健保、海外所得與基本稅額。
- 投資相關系統帳目標記 `excludeFromStats`／`excludeFromBudget`，不污染一般收支與預算。

---

## 3. 特別功能（Aster 的特色）

### 3.1 統一發票
- **電子發票**（`services/einvoice.ts`、`carrier.ts`）：手機條碼載具自動記帳（伺服器要有財政部 AppID）、紙本 QR Code、載具 CSV。
- **自動對獎器**（v3.7.0，`domain/invoice-prize.ts`、`services/invoicePrize.ts`、`/settings/invoice/prize`）：每期開獎後（資料取自財政部 RSS，經 proxy 白名單轉送，快取 1 小時）拿使用者記過的發票號碼對獎——特別獎、特獎、頭獎～六獎、增開六獎；中獎放煙火、**一鍵把中獎記成收入**（分類 `inc-lottery`，帳目帶同一個 `invoiceNo`；「已領」以 `invoiceNo` 查詢判斷）；領獎期間內有中獎會通知（也會轉送外部通知通道）。

### 3.2 智慧提醒：異常與訂閱偵測、預算預警（結果清單在 AI 助理頁；舊網址 `/insights` 轉到 `/ai`）
- **完全不用 AI**：`domain/anomaly.ts`、`budgetwarn.ts`、`pricing.ts` 純函式，本機運算，不計 AI 額度。
- **偵測項目**：沒登記的訂閱／固定扣款、訂閱**漲價**（附一年多花多少）、**疑似重複扣款**、**異常大額**。
- **三層判斷（v3.6）**：先看**你的習慣**（該分類／備註的歷史）→ 再看**分類市價**（內建行情範圍）→ 判斷不了才（使用者開啟 AI 時）請 **AI 查市價**（每筆只問一次、不計額度；沒開 AI 就只在「離譜到極端」時才提醒）。大額項目（家電、學費、買車…）不提醒。
- **預算預警**：不是「已超支」而是「照目前花法會超支」，分 early／critical／over。
- **防誤報**：資料不足不判斷（異常大額需 30 筆以上）、金額與次數雙門檻、分期與已登記週期帳目不重複提醒、籠統備註（「午餐」）不判斷重複、房租等固定扣款不算異常。
- **快取與刷新**（`services/insights.ts`）：結果快取在 `meta`（不同步），開啟 App 時閒置時間計算；**帳目任何新增／修改／刪除／復原約 1.2 秒後自動重算**（v3.10.3；以前刪帳後提醒殘留）。使用者可「略過」某項（隨帳號同步，最多留 200 筆）；新項目只通知一次（一次最多 3 則）。
- 每新增一筆支出，Dexie `creating` hook 排隊 1.5 秒，合併後逐筆檢查（`installNewTxWatcher`；匯入／同步／還原的舊帳目不觸發，`isFreshExpense` 判斷是否為剛建立）。

### 3.3 AI 全面整合（v2.0+，`docs/AI.md`）
- **預設關閉**，兩個隱私開關：`ai.enabled`、`ai.allowData`；管理員在 `.env` 設共用 Key（使用者目前只用 **Gemini**）。
- **後端**：供應商鏈 `gemini／openrouter／nvidia／custom`（OpenAI 相容），失敗自動換下一家、連續 3 次失敗冷卻 5 分鐘；額度（一般使用者／管理員分開，每日／週／月＋全站每日＋全站每分鐘；失敗不扣；收據辨識扣 2 點）。
- **功能**：AI 對話框（記帳、查帳、問 AI、整理帳本、📷 **拍照記帳**，首頁小圓球與 `/ai` 共用）；`/ai` 另有白話解讀與智慧提醒；搜尋頁只做篩選（規則看不懂的問句轉給 AI 對話框）；專案／帳戶／報表的「AI 解說」卡；收件匣「AI 解析」；首頁「上週重點」（選用）。
- **隱私**：統計類只送整數統計與分類名稱（無備註、商家、帳戶名、單筆）；送出前去除網址、身分證、卡號、連續 10 碼數字；輸出驗證（分類必須在使用者名單內）並純文字顯示；**AI 送出紀錄**（設定 → AI 設定）把每次送出的原文記在本機（不同步、最多 25 筆）。免費層的內容可能被供應商用於改進產品。

### 3.3b 操作助手（v4.0，`domain/agent/`、`services/agent.ts`、`features/home/AiChat.tsx` 的 `ChatPanel`）
用一句話整理帳本：AI（`/api/ai/agent-plan`，1 點）只規劃成「工具＋參數」，工具白名單＝批次改分類、建立／調整預算、建立週期帳目、貸款提前還款試算（只試算）、建立自動分類規則、建立存錢目標；`resolvePlan`（純函式）在記憶體工作副本上依序模擬，產生**執行預覽卡**（筆數、預算變化、餘額不變、抽樣）；`applyPlan` 單一 Dexie 交易**原子寫入**；每次執行記下修改前的樣子（本機 `meta`，7 天、20 筆），**一鍵還原**（執行後被改過的略過）。一次最多 500 筆、沒有篩選條件會被擋、沒有工具會刪帳目或動餘額。首頁對話框的「整理帳本」說法（`intent.ts`，保守）會引導過來。

### 3.3c 對帳（v4.0，`domain/reconcile.ts`、`services/reconcile.ts`、`features/settings/ReconcilePanel.tsx`，入口＝匯入 CSV →「對帳」）
帳單（CSV 或 AI 讀截圖 `/api/ai/statement`，每張 2 點）vs 帳本同帳戶：一對一配對（日期 ±3 天、金額、店名），分 **吻合／漏記／金額有差（匯差、海外手續費 1.5%）／帳本多**；一鍵補齊＝補漏記帳目、金額差另記一筆「匯差／手續費調整（對帳）」（原帳目不動，下次對帳 `ADJ_SUFFIX` 併回）、可選填實際餘額補餘額調整；可復原。截圖的明細加總與帳單合計驗證，不符要使用者確認。

### 3.3d 稅務規劃（v4.0，`domain/taxplan.ts`、`services/taxplan.ts`、`features/reports/TaxPlanCards.tsx`，不用 AI）
即將除息（已公告或依去年推估）的持股：預計配息、二代健保、邊際稅額變化（合併 vs 分開取較省）、**參與除息 vs 除息前賣出買回**（省下的稅與補充保費 − 手續費與證交稅；風險緩衝＝市值 0.5%；損益兩平價差），預設偏保守；海外所得離 100 萬門檻、稅損收割。首頁「需要你看一下」與通知會在 7 天內除息時提醒。

### 3.4 自動記帳與分類
- **自動記帳收件匣**（`features/inbox/`、`/api/hook/inbox`）：iPhone 捷徑把 Apple Pay 交易、銀行簡訊、Siri 內容送進來，規則解析成草稿，使用者確認才入帳；含來源去重。
- **自動分類規則＋商家記憶**（`domain/rules.ts`、`services/autocat.ts`）。
- **銀行／信用卡對帳單 CSV 匯入**（民國年、正數為支出、疑似重複偵測、可儲存格式），CSV 匯入精靈自動辨識 Moze。

### 3.5 資金流向桑基圖（v3.8.0，`domain/sankey.ts`、`features/reports/SankeyCard.tsx`）
收入來源 → 總收入 → 必要／非必要／投資／淨儲蓄 → 分類與帳戶；可展開到子分類；可自訂哪些分類算「必要」（設定 `sankeyEssential`）；點分類看明細。ECharts `SankeyChart`。

### 3.6 耐用品追蹤（v3.9.0，`domain/durable.ts`、`db/repo/durables.ts`、`features/plan/durables.tsx`）
- 每件耐用品：購入價、購入日、預計使用期限、（選用）追蹤使用次數。
- **每日持有成本**（購入價 ÷ 持有天數）、**預計壽命進度**（已攤提 %、再用幾天用滿、目標每天多少）、**每次使用成本**。
- **賣出**：扣掉二手殘值算「**真實成本**」，可同時記一筆收入；可「改回還在用」。
- **預計使用期限**：內部存 `lifeYears`（年，可小數）；預設選項 1/2/3/5/7/10 年＋「自訂期限…」彈窗（`features/plan/LifeSpanSheet.tsx`，**年與月各一格**，上限 100 年；`lifeYearsFrom/splitLife/lifeLabel` 在 `domain/durable.ts`）。顯示為「1 年 6 個月」。
- **與帳目連動（v3.11.0）**：購入帳目被刪除 → 耐用品一併標記刪除（`deletedAt`），復原帳目時一起復原；賣出時自動記的二手收入被刪除 → 物品改回「還在用」並暫存 `undoSale`，復原那筆收入就還原成已賣出；「改回還在用」會**一併刪除當時記的二手收入**（可從「最近刪除」復原），不會再多出一筆錢；編輯帳目時會帶出目前的耐用品期限，改金額／日期時成本與購入日同步更新，也可事後補標記或取消（`syncTxDurable`）；健康檢查新增「耐用品找不到對應的帳目」；清除範例資料時範例耐用品一起清掉。
- 資料表 `durables`（Dexie v6，`'id, status, purchaseDate, txId'`），會同步（`SYNCED_TABLES`＋伺服器 `SYNC_TABLES`）。

### 3.7 財務試算
- **財務自由試算**（`domain/fire.ts`，1,000 次蒙地卡羅）、**現金流預測**（30/90/180 天，`domain/cashflow.ts`）、**週報／月報**（`domain/summary.ts`）。

### 3.8 外部通知（v3.10.0+，`docs/NOTIFY.md`，設定 → 外部通知 `/settings/channels`）
- 把重要提醒推到 **Discord／Telegram／LINE（Messaging API，Flex 訊息）／自訂 Webhook**（HMAC `X-Aster-Signature`）。每個通道可選事件：異常、預算、週報、月報、提醒、每日、發票中獎。每人最多 10 個通道。
- **伺服器發送**：機密以 AES-256-GCM（`core/secretbox.py`，HKDF 自 JWT secret）加密存放；**SSRF 防護**（`core/outgoing.py`：只允許 https、不可帶帳密、埠 443、解析後所有 IP 必須是公網；`CLURE_NOTIFY_ALLOW_PRIVATE` 可放行內網）；不跟隨轉址；**發送時直接連線到驗證過的 IP**（TLS 的 SNI 與憑證仍用網域，不再解析第二次），擋 DNS Rebinding。
- **來源**：前端 `notify()` 經 `emitFromReminder` 轉送（含去重鍵）；伺服器排程到點時（`deliver_due`）也會同步轉送。頻率限制：事件 20/分、建立／測試 6/分、同一去重鍵 24 小時 1 次。
- 設定頁每種通道有**可摺疊的逐步教學**（`features/settings/channelGuides.ts`＋`GuideView.tsx`，含 LINE 額度說明與官方連結）。

### 3.9 通知與背景推播（`services/notifications.ts`、`services/push.ts`、`server/app/service/push_service.py`）
- **App 內提醒**（開啟與回到前景時檢查）：每日記帳、信用卡繳款、預算警示、訂閱續約／待確認、心願冷靜期、週報／月報、備份；顯示為系統通知＋提醒中心（鈴鐺）。同一個 id 只通知一次。
- **背景推播（Web Push）**：伺服器不知道帳目內容（可能端對端加密），所以由 App 算好「接下來 14 天」的提醒（`upcomingPushItems`）整批交給伺服器排程，到點才送；啟用 E2EE 時推播文字不含金額與名稱。iPhone 需 iOS 16.4+、加入主畫面、HTTPS。
- **每日記帳提醒規則（v3.10.6）**：到設定時間才通知，**且當天尚未記帳才通知**。「已記帳」= `hasLoggedOn(date)`：有**手動**帳目或手動轉帳；週期帳目、分期、股票買賣、股利、範例資料、已刪除的**不算**。
- **排程一致性（v3.10.5～3.10.6）**：
  - 伺服器 `PushService.schedule` 以**使用者**為單位整批取代尚未送出的排程（不是以裝置）；已送出的 `item_id` 不再排；`deliver_due` 同一使用者同一 `item_id` 只送一次（舊重複資料也一併標為已送）。
  - 前端 `installPushRefresh()`：帳目／轉帳／心願／週期帳目任何變動 3 秒後重新排程（所以「已記帳→取消今天的每日提醒」「刪掉唯一帳目→補排」會自動發生）；回到前景也滾動更新。
  - `disablePush` 時若仍有開著的外部通道，改為重排而非清空。
  - **提醒設定變更也會重排**（v3.11.0）：`db.settings` 的 `notify`／`weekStart`／`baseCurrency`／`monthStartDay` 一改，3 秒後重排，關掉每日提醒或改時間不會讓舊排程照送。

---

## 4. 資料與安全

### 4.1 本機資料（`src/db/`）
Dexie（IndexedDB）每個帳號獨立資料庫；schema 版本到 v6。主要表：`accounts transactions transfers categories tags saved_filters projects budgets recurring_rules installments people debts goals wishes durables rules exchange_rates stocks stock_trades dividends price_cache price_history portfolio_snapshots watchlist attachments reminders settings meta`，另有同步用的待上傳佇列。`meta` 放快取與本機狀態（不同步）。軟刪除用 `deletedAt`。同步追蹤見 `db/sync-tracking.ts`。

### 4.2 跨裝置同步與端對端加密（`services/sync.ts`、`services/e2ee.ts`、`docs/SYNC.md`）
變更約 1 秒內上傳、其他裝置 15 秒內收到（背景 60 秒）；離線記的帳連線後自動上傳；同一筆兩邊都改以較晚修改為準。**端對端加密（選用）**：伺服器只看到密文。

### 4.3 帳號與安全（`server/`、`SECURITY.md`、`docs/AUTH_DESIGN.md`）
註冊／登入（帳號或 Email）、Argon2id、JWT（HttpOnly Cookie）、Refresh 輪替與重用偵測、CSRF、頻率限制、帳號鎖定、忘記密碼寄信；**管理員後台** `/admin`（總覽、使用者管理、審計日誌、AI 主控台、資料庫備份卡片）；安全標頭與 CSP。

### 4.4 備份與可靠性
JSON 完整備份／還原（含照片）、**加密備份**（PBKDF2-SHA256 310,000 次 + AES-256-GCM）、CSV／Excel 匯出；伺服器 **SQLite 每日自動備份**（online backup＋完整性檢查＋gzip）、CLI `app.cli backup / verify-backup / restore`、`GET /api/health/ready` 就緒檢查；資料健康檢查與修復（`/settings/health`）。

### 4.5 PWA 與 iOS
離線、更新提示、啟動畫面；iPhone 主畫面最佳化（狀態列、鍵盤 visualViewport、16px 輸入框防縮放）；iOS 捷徑深層連結；桌機快速鍵（`N` 記一筆、`⌘K` 搜尋、`1`–`5` 切分頁、`L` 帳目列表）。

---

## 5. 介面與動態（Apple 質感）
- **靈動島（Liquid Glass）導覽列**（`app/TabBar.tsx`、`domain/spring.ts`）：手指按下即選取、透鏡 Q 彈到該分頁；拖曳時直接寫 transform（不經彈簧）；放開後以預先取樣的彈簧軌跡（`sampleSpring`，120fps）用 WAAPI 在合成器播放；`linear()` 彈簧 CSS 變數有 `@supports` 保護。
- **頁面轉場**：分頁左右滑、進入／返回下一層；**彈跳（過衝彈簧）只在由靈動島觸發的切換才有**（`navSource.markDockNav/isDockNav`，1 秒視窗；`useNavDirection` 對 StrictMode 安全）。
- 彈窗（`ui/Sheet.tsx`）：空白處 1:1 跟手下滑關閉、可巢狀、Esc 關閉；清單依序進場；尊重系統「減少動態效果」。
- 原創品牌：3D 星軌草寫 A 圖標；多面寶石 AI 圖示（`AiGem`）。

---

## 6. 測試與品質
- 前端 Vitest **547 項**（`tests/unit/`，fake-indexeddb）＋後端 pytest **163 項**（`server/tests/`）＝ **710 項**；`npm run check` = 型態檢查 + ESLint（0 警告）+ 測試；CI 於 main 與 feature 分支每次推送執行。
- 純函式優先放 `src/domain/`（便於測試）；有副作用的放 `src/services/`；資料庫存取放 `src/db/repo/`。

## 7. 給修改者的注意事項（踩過的坑）
1. **金額用整數最小單位**；不要新增浮點運算。
2. 改帳目的流程要同時維護帳戶餘額（`bump`／`txEffect`）；刪除是軟刪除（`deletedAt`），**筆數不變**，所以快取不能只用筆數判斷是否過期。
3. 新增會同步的資料表要同時改：`db/schema.ts`（版本）、`db/sync-tracking.ts`（`SYNCED_TABLES`）、`server/app/schema/sync.py`（`SYNC_TABLES`）；後端新表要加 Alembic 遷移（下一個是 `0010_…`）。
4. 表單裡的開關在卡片等非表單處用 `Switch`，不要用 `SwitchField`（其隱藏核取方塊會繼承輸入框寬度而撐破版面）。
5. 帶負邊距貼齊頁面邊緣的元件（例如小工具列）放進有內距的容器時要改邊距，否則會超出框。
6. 圓角容器底下若墊有色塊（滑動刪除的紅色），平常要隱藏，否則圓角邊緣會透色。
7. NAS 部署：compose 專案名是 `aster`（`sudo docker compose -p aster up -d`）；**不要刪除 Aster 資料夾**（容器 bind mount 會失效，報價代理 502），只覆蓋檔案；`.env` 與 `data/` 不在 `aster-nas.zip` 內。
8. 每次更新流程：測試通過 → 更新版本號（`package.json`、`package-lock.json`、`server/app/main.py`）與 `CHANGELOG.md`、README／總覽的測試數 → commit（訊息尾端加 Co-Authored-By）→ 推 `feature/v1.2` → `npm run pack:nas`。**版本號由使用者決定；合併／推送 `main` 要使用者明說。**
9. **新功能要加「新功能標記」**：標題前放 `<NewMark since="版本" />`，並把 `src/release.json` 的 `featureRelease`（與 `headline`）改成這一批新功能的版本——只有最新一批會亮，舊的自動熄掉；更新提示與「✨ 有新功能可用」通知也讀這個檔案（小修正不要改）；**說明文字要可折疊**：卡片標題用 `ui/Hint.tsx` 的 `Hint`（標題旁 ⓘ）、獨立說明用 `Intro`、表單列用 `LabelHint`（`SwitchField` 已內建）——折疊的是「介紹文字」，不是整組設定；確認操作用 `askConfirm()`（`stores/ui.ts`＋`app/overlays.tsx` 的 `ConfirmHost`），不要用 `window.confirm`（iOS 內建視窗）；一句話確認用 `ask('刪除這個目標？')`（`stores/ui.ts`，ConfirmHost 在 `main.tsx` 最外層）。
10. 使用者面向的文字一律繁體中文（台灣用語）；不要在回覆或文件中複述金鑰、權杖。

## 8. 想看更細？
| 主題 | 文件 |
|---|---|
| 架構圖、目錄地圖 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[PROJECT_OVERVIEW_FOR_AI.md](PROJECT_OVERVIEW_FOR_AI.md) |
| 設計與視覺 | [docs/DESIGN.md](docs/DESIGN.md)、[docs/ICONS.md](docs/ICONS.md) |
| AI | [docs/AI.md](docs/AI.md) |
| 同步與加密 | [docs/SYNC.md](docs/SYNC.md) |
| 帳號系統 | [docs/AUTH_DESIGN.md](docs/AUTH_DESIGN.md) |
| 外部通知 | [docs/NOTIFY.md](docs/NOTIFY.md) |
| 收件匣 | [docs/INBOX.md](docs/INBOX.md) |
| 維運／備份 | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| QA 清單、已知限制 | [docs/QA.md](docs/QA.md)、[docs/KNOWN_LIMITS.md](docs/KNOWN_LIMITS.md) |
| 安全 | [SECURITY.md](SECURITY.md) |
| 逐版變更 | [CHANGELOG.md](CHANGELOG.md) |

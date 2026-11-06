# Aster 記帳 — 功能說明書（給 AI 閱讀）

> 目的：讓接手的 AI（或新開發者）**不用逐檔翻程式碼**就知道「這個 App 能做什麼、每個功能怎麼運作、規則是什麼、程式在哪」。
> 與 [PROJECT_OVERVIEW_FOR_AI.md](PROJECT_OVERVIEW_FOR_AI.md)（技術棧、架構、部署、檔案地圖）互補：那份偏「怎麼建」，這份偏「做了什麼」。
> 版本：**4.1.3**（2026-11-07）。分支 `feature/v1.2`。逐版細節見 [CHANGELOG.md](CHANGELOG.md)；設計文件見 `docs/`。
> 慣例：金額內部一律用**整數最小單位**（TWD 的 1 元 = 100），不要用浮點數；使用者可見文字一律**繁體中文（台灣用語）**。

---

## 0. 一分鐘認識

**Aster 記帳**是自架的個人記帳＋股票投資組合 **PWA**，v4 起以 **AI 對話與操作助手為主軸**（但永遠「手動觸發、先預覽、確認才寫入、可還原」）：

- 資料存在使用者自己的伺服器（Synology NAS 上的 Docker），同一帳號在手機／平板／電腦間自動同步，**離線也能記帳**。
- 前端：React 18 + TypeScript + Vite + Dexie（IndexedDB）+ Zustand；後端：FastAPI + SQLAlchemy（SQLite，可換 PostgreSQL）；另有報價代理 `proxy/`。
- 操作邏輯參考 Moze 4.0，iOS 原生質感，可加入 iPhone 主畫面（底部「靈動島」玻璃導覽列）。
- **本機優先**：所有帳目先寫進本機 IndexedDB，再背景同步到伺服器；多數「聰明」功能（解析、偵測、預警、統計、試算、檢視卡）都是**本機規則運算，不呼叫 AI、不花額度**。AI 只在規則做不到、且使用者主動開啟時才用，而且是「使用者說話才花 1 點」，不會背景自動呼叫。

### 底部導覽（靈動島）
帳戶（錢包／投資）｜專案與預算（`/plan`）｜**中央圓球**｜報表｜設定。
- 中央圓球在首頁與帳目列表顯示「＋」：**點＝記一筆；長按＝語音記帳**；其他頁顯示 Logo（點＝回首頁，**長按＝叫出 AI 對話**）。
- **任何頁面往上滑＝叫出 AI 對話**（v4.1.0；`TabBar.tsx`，往上超過 34px；手指一開始上滑就取消「長按語音」計時，避免慢慢滑時誤開語音）。圓球 `touch-action: none` 才收得到上滑。
- 第一次離開首頁、且開了 AI 的人會看到一次性提示（`app/ScreenContextHost.tsx`）。

---

## 1. 基礎功能（每天都在用）

### 1.1 記一筆（`features/add/AddSheet.tsx`）
- **頂部 4 格**：支出｜收入｜轉帳｜**借貸**（內含「借出（誰欠你）／借入（你欠誰）」，即應收／應付）。「餘額調整」不在日常面板；從帳戶詳情頁的「調整餘額」進來才會多出一格。
- **計算機鍵盤**：`domain/calc-expr.ts`（**不用 `eval`**），可直接輸入 `120+80*2`；`Keypad.tsx` 也給首頁計算機共用。
- **兩層分類**、備註（含「最近常記」一點帶入）、帳戶、日期、時間。
- **「更多選項 ▾」**收納少用欄位：標籤、專案、耐用品期限、不計入預算、分帳 AA、收據照片、上一筆；**已經選了內容會自動展開**，不會藏起來。
- 已移除（v4.0.7）：頂部「一句話記帳」橫條（只有從捷徑 `/add?text=`／收件匣帶文字進來才解析）、備註欄語音鈕（iOS 鍵盤自帶聽寫；長按「＋」就是語音記帳）、手動範本（`db.templates` 表保留以相容舊備份）。
- **帳戶**：現金、銀行、信用卡、電子支付、投資等；多幣別帳戶，跨幣別記帳可填匯率或轉入金額。
- **耐用品標記**（支出才有）：「預計使用 N 年」或「自訂期限…」，存檔時同時建立耐用品（§3.6）。
- **不計入預算**（支出才有）：`excludeFromBudget = true`——預算進度與「今日還可花」都不算這筆，收支統計仍計入。
- **分帳 AA**：帳戶扣全額、統計只算「我的份額」；支援「我先付」與「別人先付」、事後結清。
- **深層連結** `/add?type=&amount=&category=&account=&note=&date=&tags=&project=&text=`，給 iOS 捷徑用。
- **數字欄位點進去自動全選**（v4.0.6，`main.tsx` 全站共用，任何 `type=number`／`inputMode=decimal|numeric` 的欄位）；清空不會跳成 0（用字串狀態，不要為數字欄位另存 number 狀態）。

### 1.2 一句話／語音記帳（`domain/nlp*.ts`、`services/voice.ts`、`features/home/VoiceSheet.tsx`）
- **純規則解析，不經任何 AI**：金額（「兩千三」「5萬2」「1,200」）、日期（「昨天」「上週五」「10/25」）、帳戶、分類、一次多筆；電話、連續 9 碼以上數字、網址不會被當成金額。
- 長按導覽列中間按鈕：Android／桌機「按住說話、放開入帳」；**iPhone 因 iOS 限制**改為放開後彈窗、點麥克風才開始說話。
- 解析檔拆成 `nlp-amount.ts`、`nlp-date.ts`、`nlp-entities.ts`、`nlp.ts`。

### 1.3 首頁（`features/home/`）— 「一個畫面一個重點」
- **主角**：選取日所在「記帳月」的總支出（大數字）＋結餘；若有總預算顯示「**今日還可花**」，否則顯示日均。**今日還可花顏色：正數紅色、負數綠色**（依使用者要求，與一般習慣相反，首頁／預算頁／快覽一致）。
- **膠囊週曆**（預設一週，可平滑展開為整月）；每天小光點／金額；左上角點開**月份選擇器**。
- **當日**：帳目清單（左滑刪除可復原、右滑編輯、長按選單）；「全部 ›」進帳目列表。
- **下半部「快覽」**（v4.1.1 放回首頁，`Widgets.tsx`）：今日支出、今日可用、淨資產…，設定 →「首頁快覽」（`/settings/widgets`）可增減與排序；預設 `['today','budget','networth']`。**提醒不在首頁**（見下）。
- **頂部右上角，由左到右**：AI 小圓球（開 AI 對話，可在設定關閉）、**計算機**（v4.1.3，§1.11）、搜尋、**提醒中心（鈴鐺）**。鈴鐺未讀數＝未讀提醒＋收件匣待確認筆數。
- **提醒中心**（`RemindersSheet.tsx`，v4.1.1）：最上面是「需要你看一下」（`AttentionCard.tsx`：📥 收件匣待確認、⚠️ 已超支、📅 除息、🔎 異常、✨ AI 上週重點），下面是提醒清單（信用卡到期、預算警示、訂閱續約、到價、備份…）；各區塊以 `.rem-stack` 固定 12px 間距（v4.1.3 修正區塊黏在一起）。系統通知未開啟時最上面有引導卡。

### 1.4 帳目列表（`features/ledger/`）
虛擬捲動、進階篩選＋常用篩選、批次操作（刪除、改分類／標籤／帳戶）、軟刪除＋「復原」、長按選單。

### 1.5 帳戶（`features/accounts/`）
- 多帳戶、淨資產計入開關、封存、初始餘額；**餘額由帳目重算保持一致**（`db/repo/accounts.ts` 的 `bump`/`txEffect`，改動帳目時先扣舊影響再加新影響）。
- **信用卡**：結帳日／繳款日、帳單週期、**額度佔用**（剩餘可用額度 = 總額度 − 欠款 − 未到期分期本金）、使用率條。
- **貸款攤還**（本息平均／本金平均）、淨資產與成長曲線。
- **帳戶詳情頁**：記一筆、轉帳／繳卡費、調整餘額、**帳單對帳**（v4.0.7，預選該帳戶，`/settings/import?mode=reconcile&account=`）、查看所有帳目。

### 1.6 預算（`features/plan/budgets.tsx`、`domain/budget.ts`、`db/repo/plan.ts`）
- **期間**：月（依「每月起算日」）、週、自訂天數；範圍：**總預算／分類／專案**；可**結轉**。
- **今日額度（動態每日可用，Moze 式）**：今日額度 = 今天開始前的剩餘預算 ÷ 剩餘天數（含今天），整天固定。
- **不算進預算的帳目**：`excludeFromStats`、`excludeFromBudget`、已刪除、非支出／手續費、借貸／投資類系統帳目（`sys-*`）。
- **預估期末花費**、預警等級 `ok / warn / over`（預設 80%）；「依過去 3 個完整月份建立預算」建議。
- 「請 AI 規劃預算」按鈕＝請操作助手規劃（先預覽、確認才建立）。

### 1.7 報表（`features/reports/`）
摘要指標（儲蓄率、收支比、日均、最大單筆）、分類環形圖（下鑽、點擊看明細）、每日／每月趨勢、近 12 個月（「年」模式不重複畫）、淨資產曲線、本月 vs 上月／去年同月、帳戶／專案／標籤／幣別篩選、**年度回顧**（`/reports/review/:year`）、**可列印 PDF**（`/reports/print`）、**資金流向桑基圖**（§3.5）。底部進階中心：現金流預測、財務自由試算、投資稅務彙總。
- 已移除（v4.0.7）：「星期幾／24 小時消費次數」圖（記帳時間不等於刷卡時間）、報表頁的「週報／月報」入口。**週報／月報頁 `/reports/summary` 仍在**（只有它有「週」單位；每週推播與「看完整週報」連結進來）。
- 統計一律用 `countsInStats`／`statAmount`（尊重 `excludeFromStats` 與分帳份額）。

### 1.8 專案與預算（`features/plan/PlanPage.tsx`，6 個分頁）
**預算｜專案｜週期與分期｜應收應付｜目標（含購物冷靜清單）｜耐用品**。舊網址 `?tab=installment` 轉到週期與分期、`?tab=wish` 轉到目標（通知連結不失效）。
- **專案／旅行**：獨立幣別、預算、統計、匯出。
- **週期帳目與訂閱**：自動入帳或「待確認」、續約提醒、價格紀錄（漲價偵測用）；**分期**：0 利率／本息平均、手續費首期或分攤。
- **應收／應付**：借出／借入動帳戶但**不計入收支與預算**。
- **存錢目標**、**購物冷靜清單**（冷靜期 3／7／14／30 天，到期問「你還想買嗎？」）、**耐用品**（§3.6）。
- 匯率管理：自動更新＋手動覆蓋（`services/fx.ts`）。

### 1.9 搜尋（`features/search/`）
只做**本機極速篩選與關鍵字搜尋**（`@玉山 >=3000 #旅遊`、`上週 午餐`…，規則見 `domain/search.ts`）與規則式「用問的查帳」（`domain/nlquery.ts`，本機免費）。規則看不懂的自然語言只留一顆「**交給 AI 對話深入分析 →**」，直接開啟全站 AI 對話視窗並送出（`useChat.getState().ask(text)`），搜尋頁不再自己養一套 AI 搜尋。

### 1.10 設定（`features/settings/SettingsPage.tsx`，v4.0.7 起核心功能在最上面）
1. **帳號與同步**（登入時）：跨裝置同步、端對端加密、隱私與安全、變更密碼、資安後台。
2. **AI 與自動化**：AI 助理（智慧提醒與額度，`/ai`）、AI 設定與額度、**首頁 AI 小圓球**開關、自動記帳收件匣、電子發票、**帳單對帳**。
3. **分類與規則**：支出／收入分類、標籤、自動分類規則。
4. **通知與整合**：通知與提醒（頁內切換「系統與推播｜外部通道」）、股票資料源與 API Key。
5. **顯示與格式**：**外觀與顯示**（深淺色、主題色、文字大小、紅漲綠跌——點開才出現的面板）、**記帳格式與起算日**（主幣別、月起算、一週起始、小數位數、千分位）、**首頁快覽**、幣別與匯率。
6. **資料**：備份／匯入／匯出、資料健康檢查、範例資料。
7. **關於**、帳號與資料管理（登出、清除所有資料）。
- 說明文字用 ⓘ（`Hint`／`Intro`）折疊；署名「Aster 記帳 · Qiyen 著 · 115.02.03」。

### 1.11 首頁計算機（v4.1.3，`features/home/CalculatorSheet.tsx`、`services/calcHistory.ts`）
- 入口：首頁右上角（搜尋左邊），底部升起的視窗（`Sheet variant="rise"`），第一次打開才載入（`HomePage` 的 `calcUsed`）。
- **計算**：沿用記帳鍵盤（`Keypad`＋`pressKey`，最多 4 位小數）；「＝」算出結果並記入記錄。
- **記帳快捷**（對目前數字運算並記錄）：＋10% 服務費、＋5% 稅、9／85／8／7 折、AA 2～6 人平分、取整、**外幣→主幣別**（用 `services/fx.getRate`，取不到匯率會提示）。
- **記錄**：預設最近 **10 筆**，可選 5／10／20／50；存在該帳號本機 `meta` 表（`calc.history`／`calc.keep`，不同步、不進備份）；和最前一筆完全相同不重複記；變少時立即裁掉。
- **一鍵複製**（純數字，不帶千分位；剪貼簿失敗退回 `execCommand`）、**一鍵記一筆**（只帶金額 `openAdd({ mode: 'expense', amount })`，帳戶／分類／日期用預設，計算機同時關閉；金額不是正數會提示）。點記錄本體會把結果帶回計算機。

---

## 2. 投資組合（`features/invest/`、`domain/invest/`、`services/quotes/`）
- **標的**：台股（`market` 值是 **`TWSE`／`TPEX`／`EMERGING`**，不是 `TW`）、美股 `US`、港股 `HK`；買進／賣出／配股／分割、整股／零股。
- **台股手續費**（折扣、最低手續費）與**證交稅**自動計算（`domain/invest/fees-tw.ts`）；成本法：加權平均／FIFO。
- **績效**：已實現／未實現、今日損益、總報酬率（含股利）、**XIRR**、「若今天賣出」淨損益、外幣股價損益與匯差拆分。
- **股利**：現金／配股、預扣稅、二代健保、自動入帳；**股利行事曆**。
- **視覺**：配置圓餅（個股／產業／市場／幣別）、市值與損益曲線、個股走勢、**損益排行**（賺最多只列報酬率 > 0、賠最多只列 < 0）。
- **觀察清單與到價提醒**（`checkPriceAlerts`）：**只在「穿越」條件那一刻通知一次**，要先站回再跌破才會再通知。
- **報價資料源**：可插拔多來源、自動 fallback＋熔斷；經 `proxy/` 報價代理（容器 `clure-quote-proxy`，nginx `/proxy`）。
- **稅務彙總**（`/reports/tax`）：合併／分開計稅、二代健保、海外所得與基本稅額。
- 投資系統帳目標記 `excludeFromStats`／`excludeFromBudget`。
- **證券戶**（`type: 'brokerage'`）：預設證券戶 `invest.defaultBrokerageId`，沒設就用第一個證券帳戶；交割帳戶 `brokerage.settlementAccountId`（買賣預設走它）。

---

## 3. 特別功能（Aster 的特色）

### 3.1 統一發票
- **電子發票**（`services/einvoice.ts`、`carrier.ts`）：手機條碼載具自動記帳（伺服器要有財政部 AppID）、紙本 QR Code、載具 CSV。
- **自動對獎器**（`domain/invoice-prize.ts`、`/settings/invoice/prize`）：開獎後對獎，中獎放煙火、**一鍵記成收入**，領獎期間內通知。

### 3.2 智慧提醒：異常與訂閱偵測、預算預警（`/ai` 頁的「智慧提醒」卡，含目前的偵測結果清單；舊網址 `/insights` 轉 `/ai`）
- **完全不用 AI**：`domain/anomaly.ts`、`budgetwarn.ts`、`pricing.ts` 純函式，本機運算。
- **偵測項目**：沒登記的訂閱／固定扣款、訂閱**漲價**、**疑似重複扣款**、**異常大額**、分類暴增。
- **三層判斷**：先看**你的習慣** → 再看**分類市價** → 判斷不了才（使用者開啟 AI 時）請 **AI 查市價**（每筆只問一次、不計額度）。大額項目不提醒。
- **預算預警**：不是「已超支」而是「照目前花法會超支」，分 early／critical／over。
- **防誤報**：資料不足不判斷、金額與次數雙門檻、分期與已登記週期帳目不重複提醒。
- **快取與刷新**（`services/insights.ts`）：結果快取在 `meta`（不同步）；**帳目任何變動約 1.2 秒後自動重算**。使用者可「略過」（隨帳號同步）；新項目只通知一次。每新增一筆支出，Dexie `creating` hook 排隊 1.5 秒檢查。
- 結果清單元件 `InsightsResults`（`features/insights/InsightsPage.tsx`）；首頁鈴鐺的「需要你看一下」只摘要，點了到 `/ai`。

### 3.3 AI 全面整合（`docs/AI.md`）
- **預設關閉**，兩個隱私開關：`ai.enabled`、`ai.allowData`；管理員在 `.env` 設共用 Key（目前只用 **Gemini**）。
- **後端**：供應商鏈 `gemini／openrouter／nvidia／custom`（OpenAI 相容），失敗自動換下一家、連續 3 次失敗冷卻 5 分鐘；額度（一般使用者／管理員分開，每日／週／月＋全站每日＋全站每分鐘；失敗不扣；收據與截圖辨識扣 2 點）。
- **一個對話框走天下**（`features/home/AiChat.tsx` 的 `ChatPanel`／`AiChatSheet`，全站唯一，`App.tsx` 的 `ChatHost` 掛在最外層；打開過一次就保持掛載，空對話關閉也有完整退場動畫）：記帳、查帳、問 AI、整理帳本、📷 拍照記帳、🎤 語音輸入（瀏覽器 SpeechRecognition，講完填進輸入框再送）、檢視卡。入口：首頁 AI 小圓球、靈動島（任何頁面上滑／非記帳頁長按）、搜尋頁「交給 AI」、預算頁「請 AI 規劃預算」、舊連結 `/ai?q=`／`?agent=`／`?tool=budget`（`aiChatStore.ask()` 開視窗並自動送出）。
- **路由一變動對話視窗自動收起**（`ScreenContextHost`），所以點檢視卡的「完整… →」會看到目的頁。
- **`/ai` 頁（設定 → AI 助理）**：只剩「智慧提醒」與 AI 額度，**不再內嵌對話**。
- **對話分流**（`respond()`，規則優先）：`localView` 短句 → 檢視卡；`looksLikeOperation` → 操作助手；規則記帳 → 草稿卡；規則查帳；問句 → `aiAsk`；口語記帳 → `draftsSmart`。
- **隱私**：統計類只送整數統計與分類名稱；送出前去除網址、身分證、卡號、連續 10 碼數字；輸出驗證並純文字顯示；**AI 送出紀錄**（設定 → AI 設定）把每次送出的原文記在本機（不同步、最多 25 筆）。免費層內容可能被供應商用於改進產品。
- 其他 AI 功能：專案／帳戶／報表的「AI 解說」卡（`features/ai/AiExplain.tsx`，與週報的白話解讀共用同一個殼）、收件匣「AI 解析」、首頁「上週重點」（選用）。

### 3.3b 操作助手（Agent）：動作圖譜（`domain/agent/`、`services/agent.ts`）
**AI 只規劃、本機預覽、你確認才寫入、整包可還原**。`/api/ai/agent-plan`（1 點）把一句話拆成最多 **8 步**，每步是 **13 個白名單工具**之一：
- 帳本整理：`reclassify` 批次改分類、`set_budget`、`add_recurring`、`add_rule`、`add_goal`、`prepayment_sim`（只試算）。
- **跨模組動作（v4.1）**：`add_transaction` 記收支、`transfer` 帳戶間轉帳（轉進信用卡／貸款＝繳費／還款，貸款附提前還款省息試算）、`settle_debt` 結清欠款、`goal_deposit` 存入目標（同一份計畫剛建的目標可直接存入）、`buy_stock`／`sell_stock` 買賣台股（賣出檢查持股夠不夠、算手續費與證交稅、預覽實拿金額）、`show_view` 在對話嵌入檢視卡（只讀）。
- **流程**：`resolvePlan`（純函式）在記憶體工作副本（交易、預算、**帳戶餘額、持股、目標、欠款**）依序模擬，前一步結果給後一步用，產生**複合預覽卡**（逐帳戶「餘額 A → B」、會變負數警告）；`applyPlan` 在**單一 Dexie 交易**橫跨帳目、轉帳、帳戶、欠款、股票交易、目標寫入，任何一步失敗整批回滾；每次執行記下修改前的樣子（本機 `meta` 的 `agent.ops`，7 天、20 筆），**整包一鍵還原**（記帳／轉帳／交易走各自的刪除流程帳戶餘額跟著回復；執行後被改過的略過）。
- **單步勾選／略過（v4.1.2）**：預覽卡每步有「☑ 執行／☐ 略過」；略過後用 AI 原始步驟（訊息的 `raw`）在**本機重新預覽**，不重問 AI、不扣額度。
- **限制**：外幣帳戶、美股港股、投資頁沒有的標的、未來日期都會被擋並請用記帳面板；一次最多 500 筆、沒有篩選條件會被擋、沒有工具會刪帳目。
- **屬性欄位名稱必須在使用者名單內**：後端 `v_agent_plan` 驗證分類／帳戶／對象／目標／標的代號；前端 `resolvePlan` 再驗證一次。

### 3.3c 對話即介面（Generative UI，`features/ai/views/`）
財務自由（蒙地卡羅 400 次＋退休年齡、每年可存兩根拉桿即時重算，不改設定）、稅務規劃（嵌入 `TaxPlanCards`）、現金流預測、花費分析，直接嵌在對話裡。**全部本機運算、不花額度**：對話框「📊」快捷鈕，或直接說「財務自由」「現金流」「如果 55 歲退休」「上個月花費」（`domain/agent/intent.ts` 的 `localView`，保守只認短句）；AI 計畫的 `show_view` 步驟在執行後依新資料重算。

### 3.3d 畫面情境（Screen Context）與靈動島全域 AI（`stores/screenContext.ts`、`app/ScreenContextHost.tsx`）
- 對話框的「📍 目前畫面」標籤：送去 AI 的問題（操作助手規劃、問 AI）前面附一句畫面摘要，**只有名稱與統計數字**，點標籤即取消，內容可在「查看送出過什麼」檢查。規則記帳、規則查帳、檢視卡不用它。
- 各頁以 `useScreenDetail(摘要|null)` 提供摘要（傳 `null`＝這一層沒有摘要，不會蓋掉別層設的）：帳戶詳情（名稱、類型、幣別、餘額）、投資（檔數、總市值、損益）、**個股頁**（代號、名稱、持有股數）、報表（期間、收支）、專案與預算（分頁；預算分頁另提供各預算使用率 ≥ 80%）、**帳目列表**（期間、篩選條件名稱、金額範圍、關鍵字、筆數與合計）。路由自動給頁面名稱（`labelForPath`）。
- **畫面專屬晶片**：對話框空狀態依畫面插入「⚡」晶片（個股頁買／賣 1 張這檔、帳戶頁轉帳…，需補內容的只填輸入框）；本機規則產生，不用 AI。
- 後端提示詞教 AI 把「這檔」「這個帳戶」優先對應到目前畫面（需求開頭 `【目前畫面】…`）。

### 3.3e 對帳（`domain/reconcile.ts`、`services/reconcile.ts`、`features/settings/ReconcilePanel.tsx`；入口：帳戶詳情「帳單對帳」、設定 → AI 與自動化 → 帳單對帳）
帳單（CSV 或 AI 讀截圖，每張 2 點）vs 帳本同帳戶：一對一配對（日期 ±3 天、金額、店名），分 **吻合／漏記／金額有差（匯差、海外手續費）／帳本多**；一鍵補齊＝補漏記帳目、金額差另記一筆「匯差／手續費調整（對帳）」（以原帳目 id 末 10 碼綁定，下次對帳併回）、可選填實際餘額補餘額調整；可復原。截圖明細加總與帳單合計驗證，不符要使用者確認。步驟點：對帳 3 步（匯入 4 步）。

### 3.3f 稅務規劃（`domain/taxplan.ts`、`services/taxplan.ts`、`features/reports/TaxPlanCards.tsx`，不用 AI）
即將除息的持股：預計配息、二代健保、邊際稅額變化（合併 vs 分開取較省）、**參與除息 vs 除息前賣出買回**（省下的稅與補充保費 − 手續費與證交稅；風險緩衝＝市值 0.5%），預設偏保守；海外所得離 100 萬門檻、稅損收割。鈴鐺的「需要你看一下」在 7 天內除息時提醒。

### 3.4 自動記帳與分類
- **自動記帳收件匣**（`features/inbox/`、`/api/hook/inbox`）：iPhone 捷徑把 Apple Pay 交易、銀行簡訊、Siri 內容送進來，規則解析成草稿，確認才入帳；含來源去重。
- **自動分類規則＋商家記憶**（`domain/rules.ts`、`services/autocat.ts`）。
- **銀行／信用卡對帳單 CSV 匯入**（民國年、正數為支出、疑似重複偵測、可儲存格式），自動辨識 Moze。
- **不支援**：直連銀行 API（台灣沒有開放給個人的管道）、Email 自動收帳單（規劃中，建議做「轉寄到專屬地址」）。

### 3.5 資金流向桑基圖（`domain/sankey.ts`、`features/reports/SankeyCard.tsx`）
收入來源 → 總收入 → 必要／非必要／投資／淨儲蓄 → 分類與帳戶；可展開子分類；可自訂「必要」分類（`sankeyEssential`）。

### 3.6 耐用品追蹤（`domain/durable.ts`、`db/repo/durables.ts`、`features/plan/durables.tsx`）
- 購入價、購入日、預計使用期限（內部存 `lifeYears`，可小數；選項 1/2/3/5/7/10 年＋「自訂期限…」彈窗，年與月各一格，上限 100 年）、（選用）使用次數。
- **每日持有成本**、**壽命進度**、**每次使用成本**；**賣出**：扣二手殘值算「真實成本」並可記一筆收入；可「改回還在用」（一併刪除當時記的二手收入）。
- **與帳目連動**：購入帳目被刪除 → 耐用品一併標記刪除，復原時一起復原；賣出收入被刪除 → 改回還在用並暫存 `undoSale`；編輯帳目帶出期限、`syncTxDurable`；健康檢查檢查孤兒耐用品。
- 資料表 `durables`（Dexie v6），會同步。

### 3.7 財務試算
**財務自由試算**（`domain/fire.ts`，1,000 次蒙地卡羅；現況取自 `services/fireBasis.ts`，與對話檢視卡共用）、**現金流預測**（30/90/180 天，`domain/cashflow.ts`）、**週報／月報**（`domain/summary.ts`）。數字欄位輸入用字串狀態。

### 3.8 外部通知（`docs/NOTIFY.md`）
- 把重要提醒推到 **Discord／Telegram／LINE／自訂 Webhook**（HMAC `X-Aster-Signature`）。每個通道可選事件；每人最多 10 個通道。入口：**設定 → 通知與提醒 → 頂部切到「外部通道」**（`NotifTabs.tsx`；舊網址 `/settings/channels` 仍可用）。
- **伺服器發送**：機密以 AES-256-GCM 加密；**SSRF 防護**（只允許 https、埠 443、解析後 IP 必須是公網）；不跟隨轉址；**發送時直連已驗證的 IP**，擋 DNS Rebinding。
- 頻率限制：事件 20/分、建立／測試 6/分、同一去重鍵 24 小時 1 次。每種通道有可摺疊的逐步教學。

### 3.9 通知與背景推播（`services/notifications.ts`、`services/push.ts`、`server/app/service/push_service.py`）
- **App 內提醒**（開啟與回到前景時檢查）：每日記帳、信用卡繳款、預算警示、訂閱續約／待確認、心願冷靜期、週報／月報、備份；顯示為系統通知＋提醒中心。同一個 id 只通知一次。
- **背景推播（Web Push）**：伺服器不知道帳目內容，由 App 算好「接下來 14 天」的提醒整批交給伺服器排程；啟用 E2EE 時推播文字不含金額與名稱。iPhone 需 iOS 16.4+、加入主畫面、HTTPS。
- **每日記帳提醒**：到設定時間才通知，**且當天尚未記帳**（`hasLoggedOn`：有手動帳目或手動轉帳；週期、分期、股票、股利、範例資料不算）。
- **排程一致性**：伺服器以使用者為單位整批取代尚未送出的排程；`installPushRefresh()` 在帳目／轉帳／心願／週期帳目變動 3 秒後重排；`notify`／`weekStart`／`baseCurrency`／`monthStartDay` 設定變更也會重排。

---

## 4. 資料與安全

### 4.1 本機資料（`src/db/`）
Dexie（IndexedDB）每個帳號獨立資料庫；schema 版本到 v6。主要表：`accounts transactions transfers categories tags saved_filters projects budgets recurring_rules installments people debts goals wishes durables rules exchange_rates stocks stock_trades dividends price_cache price_history portfolio_snapshots watchlist attachments reminders settings meta`，另有同步用的待上傳佇列。`meta` 放快取與本機狀態（**不同步**）：insights 快取、`agent.ops` 還原紀錄、`calc.history`／`calc.keep`、`homeWidgetsRestored` 等。軟刪除用 `deletedAt`。同步追蹤見 `db/sync-tracking.ts`。

### 4.2 跨裝置同步與端對端加密（`services/sync.ts`、`services/e2ee.ts`、`docs/SYNC.md`）
變更約 1 秒內上傳、其他裝置 15 秒內收到；離線記的帳連線後自動上傳；同一筆兩邊都改以較晚修改為準。**端對端加密（選用）**：伺服器只看到密文。

### 4.3 帳號與安全（`server/`、`SECURITY.md`、`docs/AUTH_DESIGN.md`）
註冊／登入、Argon2id、JWT（HttpOnly Cookie）、Refresh 輪替與重用偵測、CSRF、頻率限制、帳號鎖定、忘記密碼寄信；**管理員後台** `/admin`（總覽、使用者、審計日誌、**AI 主控台**、資料庫備份卡片）。AI 主控台（`features/admin/AiConsole.tsx`）：供應商狀態與測試、用量（今日／本週／本月三欄、近 7 天長條、依身分與各使用者的對齊表格）、額度設定（一般使用者／管理員／全站三組，各三個輸入欄）。安全標頭與 CSP。

### 4.4 備份與可靠性
JSON 完整備份／還原（含照片）、**加密備份**（PBKDF2-SHA256 310,000 次 + AES-256-GCM）、CSV／Excel 匯出；伺服器 **SQLite 每日自動備份**、CLI `app.cli backup / verify-backup / restore`、`GET /api/health/ready`；資料健康檢查與修復（`/settings/health`）。

### 4.5 PWA 與 iOS
離線、更新提示（並以 `release.json` 的「✨ 有新功能可用」通知）、啟動畫面；iPhone 主畫面最佳化；iOS 捷徑深層連結；桌機快速鍵（`N` 記一筆、`⌘K` 搜尋、`1`–`5` 切分頁、`L` 帳目列表）。**首次引導 4 步**（歡迎與幣別 → 外觀 → 第一個帳戶 → 範例資料），功能介紹改由設定裡的「新」標記與更新通知承擔。

---

## 5. 介面與動態（Apple 質感）
- **靈動島（Liquid Glass）導覽列**（`app/TabBar.tsx`、`domain/spring.ts`）：手指按下即選取、透鏡 Q 彈；拖曳時直接寫 transform；放開後以預先取樣的彈簧軌跡（`sampleSpring`，120fps）用 WAAPI 在合成器播放。中央圓球的長按／上滑手勢見 §0。
- **頁面轉場**：分頁左右滑、進入／返回下一層；**彈跳只在由靈動島觸發的切換才有**（`navSource`）。
- **彈窗（`ui/Sheet.tsx`）**：空白處 1:1 跟手下滑關閉、可巢狀、Esc 關閉；`variant="rise"`（對話、計算機）從底部升起；**拖到一半放開是平順彈回**（進場動畫不會被重播；退場動畫在套上 `closing` class 的同一個畫面才還給樣式表，`useLayoutEffect`）。尊重系統「減少動態效果」。
- 原創品牌：3D 星軌草寫 A 圖標；多面寶石 AI 圖示（`AiGem`）。

---

## 6. 測試與品質
- 前端 Vitest **560 項**（`tests/unit/`，fake-indexeddb；含 `agent-actions`、`agent-intent`、`calc-history`）＋後端 pytest **165 項**（`server/tests/`）＝ **725 項**；`npm run check` = 型態檢查 + ESLint（0 警告）+ 測試；CI 於 main 與 feature 分支每次推送執行。
- 純函式優先放 `src/domain/`（便於測試）；有副作用的放 `src/services/`；資料庫存取放 `src/db/repo/`。

## 7. 給修改者的注意事項（踩過的坑）
1. **金額用整數最小單位**；不要新增浮點運算。
2. 改帳目的流程要同時維護帳戶餘額（`bump`／`txEffect`）；刪除是軟刪除（`deletedAt`），**筆數不變**，快取不能只用筆數判斷是否過期。
3. 新增會同步的資料表要同時改：`db/schema.ts`（版本）、`db/sync-tracking.ts`（`SYNCED_TABLES`）、`server/app/schema/sync.py`（`SYNC_TABLES`）；後端新表要加 Alembic 遷移（下一個是 `0010_…`）。
4. 表單裡的開關在卡片等非表單處用 `Switch`，不要用 `SwitchField`；全域 `appearance: none`，不要用原生核取方塊。
5. 帶負邊距貼齊頁面邊緣的元件放進有內距的容器時要改邊距；grid 子項要 `min-width: 0`；彈窗內容要確認 375 寬不橫向溢出。
6. 圓角容器底下若墊有色塊（滑動刪除的紅色），平常要隱藏。
7. **數字欄位**：用字串狀態，不要為 `type=number` 另存 number 狀態（清空會跳 0、輸入變 01234）；全站已在 `main.tsx` 聚焦全選。
8. **不要在 `loadSettings` 或會被同步測試呼叫的地方寫入 `db.settings`**（會改變同步佇列，sync 測試會壞）；一次性遷移標記放不同步的 `meta`，只在確實需要時才寫設定。
9. **對話視窗**：`ChatHost` 用「打開過就保持掛載」，不要用 `msgs.length` 判斷掛載（空對話關閉會被直接拔掉、沒有退場動畫）；`ScreenContextHost` 在路由變動時關閉視窗，所以要「開視窗再送出」的流程（舊連結 `/ai?q=`）要先清參數、晚一拍再 `ask()`。
10. **`useScreenDetail(null)` 不會清除別層設的摘要**；頁面載入中傳 `null`，讓子元件可以提供更詳細的摘要（預算分頁：`PlanPage` 傳 `null`、`budgets.tsx` 提供）。
11. **台股 `market` 是 `TWSE`／`TPEX`／`EMERGING`**，沒有 `TW`；測試資料要用真實值（曾因 mock 成 `TW` 導致真實台股全被擋）。
12. 操作助手新增工具要同時改四處：`domain/agent/plan.ts`（resolver、`Op` 型別、`ToolName`）、`services/agent.ts`（`applyPlan` 與 `undoOp` 的還原方式）、後端 `ai_tasks.py`（提示詞、`AGENT_TOOLS`、`v_agent_plan` 驗證）、測試（`agent-actions.test.ts`＋`test_ai.py`）；會動帳戶的工具要在單一 Dexie 交易內，且**不可在交易內做網路請求**（目前因此只支援主幣別帳戶）。
13. NAS 部署：compose 專案名是 `aster`（`sudo docker compose -p aster up -d`）；**不要刪除 Aster 資料夾**（bind mount 會失效，報價代理 502），只覆蓋檔案；覆蓋後用 `--force-recreate`；`.env` 與 `data/` 不在 `aster-nas.zip` 內。
14. 每次更新流程：測試通過 → 更新版本號（`package.json`、`package-lock.json` 第 3 與 9 行、`server/app/main.py`）與 `CHANGELOG.md`、README／總覽／本文件的測試數 → commit（訊息尾端加 Co-Authored-By）→ 推 `feature/v1.2` → 快轉合併並推 `main`（使用者已長期授權）→ `npm run pack:nas`。**版本號由使用者決定**；不 force-push；測試沒過不推。
15. **新功能要加「新功能標記」**：標題前放 `<NewMark since="版本" />`，並把 `src/release.json` 的 `featureRelease`（與 `headline`）改成這一批新功能的版本——只有最新一批會亮；小修正不要改。**說明文字要可折疊**：卡片標題用 `ui/Hint.tsx` 的 `Hint`、獨立說明用 `Intro`、表單列用 `LabelHint`——折疊的是「介紹文字」，不是整組設定；確認操作用 `askConfirm()`／`ask()`（`stores/ui.ts`，`ConfirmHost` 在 `main.tsx` 最外層），不要用 `window.confirm`；沒必要的說明文字不要加。
16. 使用者面向的文字一律繁體中文（台灣用語）；不要在回覆或文件中複述金鑰、權杖。

## 8. 想看更細？
| 主題 | 文件 |
|---|---|
| 架構圖、目錄地圖 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[PROJECT_OVERVIEW_FOR_AI.md](PROJECT_OVERVIEW_FOR_AI.md) |
| 設計與視覺 | [docs/DESIGN.md](docs/DESIGN.md)、[docs/ICONS.md](docs/ICONS.md) |
| AI（含操作助手、動作圖譜、對話即介面） | [docs/AI.md](docs/AI.md) |
| 同步與加密 | [docs/SYNC.md](docs/SYNC.md) |
| 帳號系統 | [docs/AUTH_DESIGN.md](docs/AUTH_DESIGN.md) |
| 外部通知 | [docs/NOTIFY.md](docs/NOTIFY.md) |
| 收件匣 | [docs/INBOX.md](docs/INBOX.md) |
| 維運／備份 | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| QA 清單、已知限制 | [docs/QA.md](docs/QA.md)、[docs/KNOWN_LIMITS.md](docs/KNOWN_LIMITS.md) |
| 安全 | [SECURITY.md](SECURITY.md) |
| 逐版變更 | [CHANGELOG.md](CHANGELOG.md) |

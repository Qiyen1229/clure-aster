# AI 輔助（選用）

一句話／語音記帳的**規則解析看不懂時**，才請第三方模型解析一次。管理員共用一把 Key，每位使用者有每日／每週／每月的免費額度。

```
按下送出 → 規則解析（本機、免費）→ 找到金額就結束
                              └ 找不到 ＋ 使用者開啟了 AI → POST /api/ai/parse-entry
                                    └ 檢查額度（預留）→ 供應商鏈（OpenRouter → NVIDIA → 自訂）→ 驗證輸出 → 回傳草稿
```

## 設定（`.env`，見 `.env.example`）

| 變數 | 說明 |
|---|---|
| `CLURE_AI_PROVIDERS` | 嘗試順序，逗號分隔：`openrouter`、`nvidia`、`custom`（預設 `openrouter,nvidia`） |
| `CLURE_AI_OPENROUTER_API_KEY` / `_MODEL` | OpenRouter；模型名稱結尾 `:free` 的有免費額度（有每分鐘／每日上限，以官方公告為準） |
| `CLURE_AI_NVIDIA_API_KEY` / `_MODEL` | NVIDIA NIM（build.nvidia.com） |
| `CLURE_AI_CUSTOM_BASE_URL` / `_API_KEY` / `_MODEL` | 任何 OpenAI 相容服務（Groq、本機 Ollama…） |
| `CLURE_AI_USER_DAILY` / `_WEEKLY` / `_MONTHLY` | 每位使用者的預設上限（20／80／250），0＝不限 |
| `CLURE_AI_GLOBAL_DAILY` | 全站每日上限（預設 300），保護上游免費額度，0＝不限 |

管理後台「AI 主控台」可開關 AI、調整四個額度、測試連線並查看全部狀態；改過後以後台為準（`app_settings`）。Key 只在伺服器 `.env`，不會送到前端或顯示在後台。改 `.env` 後執行 `docker compose up -d`。

## NAS 上線步驟（熱更新版）

1. **電腦上打包**：在專案資料夾執行 `npm run pack:nas`，產生 `aster-nas.zip`（不含 `.env` 與 `data/`，不會動到你的設定與資料庫）。
2. **覆蓋到 NAS**：把 zip 解壓縮後覆蓋到 NAS 上同一個專案資料夾（**不要先刪除資料夾**）。`web-builder` 會自動重新建置前端（約 30–90 秒），後端自動熱重載並套用遷移 `0007_ai_usage`。
3. **編輯 NAS 上的 `.env`**，至少加入一把 Key（沒有的供應商留空；變數說明見 `.env.example`）：
   ```
   CLURE_AI_OPENROUTER_API_KEY=sk-or-v1-你的Key
   CLURE_AI_NVIDIA_API_KEY=nvapi-你的Key
   ```
   - 其餘變數都有預設值，不用加；想改額度或模型才需要加（`CLURE_AI_USER_DAILY`、`CLURE_AI_OPENROUTER_MODEL` 等）。
   - OpenRouter Key：https://openrouter.ai/keys　NVIDIA Key：https://build.nvidia.com （登入後在模型頁產生 API Key）。
4. **套用設定**（這版 `docker-compose.yml` 多了 `CLURE_AI_*` 變數，必須重建 api 容器）：
   ```bash
   docker compose up -d
   ```
5. **確認上線**：`docker compose logs -f api` 看到「資料庫結構已是最新版本」；App「設定 → 關於」版本為 1.5.1（沒變就按「檢查更新」）。
6. **確認 Key 有效**（三選一，建議 A）：
   - **A. App 內**：管理員登入 →「資安後台 → AI 主控台」→「全部測試」。綠燈＋毫秒數＝Key、網址、模型都正確；紅燈會寫原因（401＝Key 錯誤、404＝模型名稱或網址錯誤、429＝被限流或免費額度用完）。
   - **B. NAS 終端機**：`docker compose exec api /opt/venv/bin/python -m app.cli ai-test`（可加 `--provider nvidia` 只測一家）。
   - **C. 實際使用**：到「設定 → AI 輔助」開啟，在記帳面板輸入規則看不懂的一句話（例如「剛剛買了一個東西忘記多少」會因為沒有金額而呼叫 AI；要有金額的話規則本身就能解析，不會用到 AI），看主控台「最近 20 次呼叫」是否出現。
7. **開放給使用者**：每位使用者自己到「設定 → AI 輔助」開啟（預設關閉）。額度、開關在 AI 主控台調整。

> 免費模型的名稱與限額常變動。若測試回 404，到供應商網站找一個目前可用的免費模型，把名稱填進 `.env` 的 `CLURE_AI_*_MODEL`，再 `docker compose up -d`。

## AI 主控台（管理員）

「資安後台 → AI 主控台」（`/admin/ai`）一頁看全部，每 30 秒自動更新：

- **整體狀態**：幾個供應商已設定、幾個確認正常；伺服器時間與額度時區。
- **供應商（依嘗試順序）**：狀態（🟢 正常／🔴 最近失敗／🟠 冷卻中／🔵 尚未測試／⚪️ 未設定）、模型、主機、Key 最後 4 碼、自上次 API 重啟的成功／失敗次數、最近成功時間與延遲、最近一次錯誤與原因，以及「測試連線」按鈕（送 1 次極小請求，不扣使用者額度，成功會解除冷卻）。
- **用量**：今日／本週／本月總次數、今日各供應商用量、近 7 天長條圖。
- **各使用者用量**（本月前 30 名）、**最近 20 次呼叫**（時間、使用者、功能、供應商、模型；不含內容）。
- **開關與額度**：AI 總開關、每人每日／每週／每月、全站每日上限。

連線狀況（成功／失敗次數、最近錯誤、冷卻）記在 API 程序的記憶體，**重啟會歸零**；用量與呼叫紀錄在資料庫，不會歸零。失敗的呼叫不會進紀錄（不扣額度），原因看供應商卡片或 `docker compose logs api`。

## 額度規則

- 重置時間以 `CLURE_TIMEZONE`（預設 Asia/Taipei）：每日 00:00、每週一 00:00、每月 1 日 00:00。
- 日／週／月**任何一層**用完就擋（429，訊息指出哪一層與重置時間）；全站每日上限另外計算。
- 用量＝時間區間內 `ai_usage` 的 `cost` 加總，沒有會重置的計數器。呼叫前先「預留」一列，成功才保留；**供應商全部失敗、或回傳看不懂的內容時整列刪除，不扣額度**。
- 另有每位使用者每分鐘 10 次的頻率限制。

## 供應商鏈

依序嘗試；HTTP 錯誤（含 429）、逾時、回應不是 JSON 都換下一家。同一家連續失敗 3 次冷卻 5 分鐘（記憶體內，重啟歸零）。免費模型的 JSON 輸出不一定穩定，伺服器容忍 ```` ```json ```` 圍欄與前後說明文字，並嚴格驗證：分類／帳戶必須在使用者給的名單內、金額 0～1e12、日期在過去 2 年到未來 30 天內，不合格的欄位丟棄或整筆丟棄。

## 隱私

- 預設關閉；使用者在「設定 → AI 輔助」手動開啟（只要 `VITE_AUTH_MODE` 沒關）。
- 只送：你輸入的那一句話、今天日期、分類與帳戶**名稱**。不送任何帳目紀錄、餘額與 id。
- 內容會經過你的伺服器與第三方供應商，**不在端對端加密範圍內**；免費模型的服務條款可能記錄或使用輸入。伺服器日誌與 `ai_usage` 只記次數、供應商與模型，不記內容。
- 輸入中的即時預覽（語音彈窗）不會呼叫 AI；只有明確送出才會。

## 端點

| 路徑 | 說明 |
|---|---|
| `GET /api/ai/status` | 是否可用、訊息、我的日／週／月額度 |
| `POST /api/ai/parse-entry` | `{text, categories[], accounts[], today}` → `{entries[], quota}` |
| `GET/PATCH /api/admin/ai` | 管理員：開關、額度、供應商狀態、今日用量 |
| `GET /api/admin/ai/console` | 管理員：主控台全部資料（供應商健康、用量、各使用者、最近呼叫、7 日統計） |
| `POST /api/admin/ai/test` | 管理員：`{provider}` 測試連線與 Key（每分鐘 6 次，寫入審計日誌 `admin.ai_test`） |

資料表 `ai_usage`（遷移 `0007_ai_usage`）。程式：`server/app/service/ai_{quota,providers,service}.py`；前端 `src/services/ai.ts`、`src/domain/aiparse.ts`、`src/features/settings/AiPage.tsx`。

## 之後可擴充

收據照片辨識（`cost` 可設 2）、簡訊／通知解析後備、週報月報白話洞察、每位使用者個別額度。

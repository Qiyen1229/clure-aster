# 帳號系統與管理員資安後台 — 設計文件

> 目標：加入帳號註冊／登入、角色權限（RBAC）與管理員資安後台；帳目以本機 IndexedDB 為主（離線可用），並與伺服器雙向同步（見 [SYNC.md](SYNC.md)）。

## 1. 架構總覽

```
瀏覽器（React PWA）──同源 /api──▶ nginx（web 容器，9122）──▶ FastAPI（api 容器，8000）──▶ SQLite / PostgreSQL
        │                                    └─ /proxy ──▶ quote-proxy（報價代理）
        └─ IndexedDB：每位使用者一個獨立資料庫 clure-u{userId}（記帳資料不上傳）
```

- 前後端同源（nginx 反向代理 `/api`），Cookie 可設 `SameSite=Lax`，不需開放 CORS。
- 伺服器保存帳號、權杖、審計日誌，以及跨裝置同步的帳目（`sync_records`）。

## 2. 後端目錄結構（五層架構）

```
server/
├─ app/
│  ├─ main.py               FastAPI 應用建立、中介層（CSRF、請求日誌）、例外處理、生命週期（建立預設管理員）
│  ├─ db.py                 Engine／Session 工廠（SQLite 啟用 WAL 與外鍵）
│  ├─ cli.py                指令列工具：建立管理員
│  ├─ core/                 橫切關注點（非業務）
│  │  ├─ config.py          環境變數設定（pydantic-settings，前綴 CLURE_）
│  │  ├─ security.py        Argon2id 密碼雜湊、JWT 簽發／驗證、隨機權杖
│  │  ├─ rate_limit.py      滑動視窗頻率限制（記憶體）
│  │  ├─ request_info.py    取得客戶端 IP（信任 nginx 轉發標頭）與 User-Agent
│  │  └─ logging.py         標準 logging 設定與脫敏工具（遮罩 Email）
│  ├─ model/                ORM 實體（SQLAlchemy 2.0）
│  │  ├─ base.py  user.py  refresh_token.py  audit_log.py
│  ├─ schema/               Pydantic 請求／回應模型（嚴格型別、不含密碼雜湊等敏感欄位）
│  │  ├─ auth.py  admin.py  audit.py  sync.py
│  ├─ repository/           資料庫查詢與寫入（唯一可操作 Session 查詢的層）
│  │  ├─ user_repository.py  token_repository.py  audit_repository.py  stats_repository.py
│  ├─ service/              業務邏輯、權限與業務規則
│  │  ├─ auth_service.py  admin_service.py  audit_service.py  stats_service.py  errors.py
│  └─ api/                  路由、依賴注入、HTTP 回應封裝（不直接操作 DB）
│     ├─ deps.py  auth.py  admin.py  sync.py  health.py  cookies.py
├─ alembic/                 資料庫遷移（versions/0001_initial.py）
├─ tests/                   pytest（認證、鎖定、頻率限制、CSRF、權杖輪替、RBAC、管理功能、審計）
├─ Dockerfile  requirements.txt  alembic.ini
```

## 3. 資料庫 Schema

### users
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | INTEGER PK | |
| username | VARCHAR(32) UNIQUE, INDEX | 3–32 字元：英數、`_`、`.`、`-` |
| email | VARCHAR(254) UNIQUE, INDEX | 正規化為小寫 |
| password_hash | VARCHAR(255) | Argon2id（含參數與 salt） |
| role | VARCHAR(16) | `user`／`admin` |
| is_active | BOOLEAN | `false` = 凍結 |
| failed_login_count | INTEGER | 連續登入失敗次數（成功後歸零） |
| locked_until | DATETIME NULL | 暫時鎖定到期時間 |
| token_version | INTEGER | 遞增即讓所有既有 Access Token 失效（強制登出、凍結、改密碼） |
| must_change_password | BOOLEAN | 管理員重設密碼後須先改密碼 |
| created_at / updated_at | DATETIME | UTC |
| last_login_at | DATETIME NULL | 最後成功登入 |
| last_seen_at | DATETIME NULL | 最後活動（登入、刷新權杖）→「今日活躍」 |
| password_changed_at | DATETIME NULL | |

### refresh_tokens
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | VARCHAR(64) PK | JWT `jti` |
| user_id | INTEGER FK → users.id, INDEX | ON DELETE CASCADE |
| family_id | VARCHAR(64) INDEX | 同一次登入的輪替鏈；偵測重用時整條鏈撤銷 |
| expires_at | DATETIME | |
| revoked_at | DATETIME NULL | |
| replaced_by | VARCHAR(64) NULL | 輪替後的新 jti |
| created_at | DATETIME | |
| ip / user_agent | VARCHAR | 稽核用 |

### audit_logs
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | INTEGER PK | |
| created_at | DATETIME INDEX | UTC |
| user_id | INTEGER NULL, INDEX | 被操作／登入的帳號 |
| actor_id | INTEGER NULL | 執行者（管理員操作時） |
| action | VARCHAR(64) INDEX | 見下表 |
| success | BOOLEAN INDEX | 執行結果 |
| ip | VARCHAR(64) | 客戶端 IP |
| user_agent | VARCHAR(512) | |
| detail | TEXT NULL | JSON；**絕不包含密碼、權杖** |

`action`：`auth.register`、`auth.login`、`auth.login_locked`、`auth.logout`、`auth.refresh_reuse`、`auth.password_change`、`admin.user_list_view`、`admin.audit_view`、`admin.stats_view`、`admin.user_freeze`、`admin.user_unfreeze`、`admin.force_logout`、`admin.password_reset`。

## 4. API 端點

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| GET | `/api/health` | 公開 | 健康檢查 |
| POST | `/api/auth/register` | 公開（可關閉） | 註冊；頻率限制 5 次／分／IP |
| POST | `/api/auth/login` | 公開 | 帳號或 Email＋密碼；5 次／分／IP＋帳號；連續 5 次失敗鎖 15 分鐘 |
| POST | `/api/auth/refresh` | Refresh Cookie | 輪替 Refresh Token；重用偵測 → 撤銷整條鏈 |
| POST | `/api/auth/logout` | 登入 | 撤銷本裝置 Refresh Token 鏈、清除 Cookie |
| GET | `/api/auth/me` | 登入 | 目前使用者 |
| POST | `/api/auth/change-password` | 登入 | 驗證舊密碼、使其他裝置登出 |
| GET | `/api/admin/stats` | admin | 總用戶、今日活躍、今日登入失敗、資料庫容量 |
| GET | `/api/admin/users` | admin | 分頁、搜尋、狀態篩選 |
| PATCH | `/api/admin/users/{id}/status` | admin | 凍結／啟用（不可凍結自己） |
| POST | `/api/admin/users/{id}/force-logout` | admin | 撤銷所有權杖 |
| POST | `/api/admin/users/{id}/reset-password` | admin | 產生一次性臨時密碼，使用者下次登入須改密碼 |
| GET | `/api/admin/audit-logs` | admin | 篩選：動作、使用者、結果、日期區間；分頁 |
| GET | `/api/sync/status` | 登入 | 同步狀態（筆數、游標） |
| POST | `/api/sync/push` | 登入 | 上傳本機變更（最後寫入者勝，回傳未採用項目的伺服器版本） |
| GET | `/api/sync/pull` | 登入 | 依游標下載其他裝置的變更 |

錯誤格式：`{"detail": "繁體中文訊息"}`；伺服器錯誤不回傳內部細節。

## 5. 資安設計

| 項目 | 做法 |
|---|---|
| 密碼 | Argon2id（argon2-cffi 預設參數：time_cost=3、memory=64MiB），自動 rehash；長度 8–128，需含英文與數字；不允許與帳號相同 |
| 帳號列舉 | 登入失敗一律「帳號或密碼錯誤」；找不到帳號時仍執行一次假雜湊驗證，避免時間差 |
| Access Token | JWT HS256，15 分鐘，含 `sub`、`role`、`ver`（token_version）、`type=access`；每次請求比對 DB 的 `is_active` 與 `token_version` |
| Refresh Token | JWT＋DB 紀錄，14 天，每次刷新輪替；舊權杖再次使用＝遭竊 → 撤銷整條鏈並寫入審計 |
| Cookie | `HttpOnly`、`SameSite=Lax`、`Secure`（自動：經 HTTPS 時開啟）；Access 路徑 `/api`，Refresh 路徑 `/api/auth` |
| CSRF | Double-submit：伺服器發放非 HttpOnly 的 `csrf_token` Cookie，所有非 GET 請求須帶相同值的 `X-CSRF-Token` 標頭 |
| 暴力破解 | 頻率限制（IP、IP＋帳號）＋ 帳號鎖定（DB 計數，重啟不失效） |
| 權限 | 後端 `require_admin` 依賴；前端 `/admin/*` 路由守衛僅為 UX，不作為安全邊界 |
| 日誌 | 標準 logging；不記錄密碼、權杖；Email 遮罩（`a***@example.com`） |
| JWT 金鑰 | `CLURE_JWT_SECRET`；未設定時自動產生並保存在資料目錄（容器重啟不會登出所有人） |
| 管理員 | 以環境變數 `CLURE_ADMIN_*` 於首次啟動建立，或 `python -m app.cli create-admin` |

## 6. 本機資料與帳號關聯

- 每位使用者使用獨立的 IndexedDB：`clure-u{userId}`，`meta.ownerUserId` 記錄擁有者。同一台裝置多人登入互不干擾。
- 登出不刪除本機資料，只是需要重新登入才能存取。
- 升級前（未登入時代）的資料庫 `clure`：首次登入時詢問是否歸屬到目前帳號（複製後刪除舊庫）。
- 離線時：若此裝置曾登入過，允許以「離線模式」使用本機資料；恢復連線後自動重新驗證。

## 7. 跨裝置同步

已實作，詳見 [SYNC.md](SYNC.md)：前端 DBCore 中介層追蹤變更，後端 `/api/sync/push`、`/api/sync/pull` 以最後寫入者勝合併。

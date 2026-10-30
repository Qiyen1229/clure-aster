# 維運手冊（備份、還原、升級、監控）

適用於 Synology NAS 的 Docker 部署（專案資料夾 `/volume1/docker/Aster`、compose 專案名 `aster`、API 容器 `clure-api`）。

## 1. 備份：該備份什麼

| 內容 | 位置 | 怎麼備份 |
|---|---|---|
| 資料庫（帳號、同步的帳目） | `data/api/clure.db`（SQLite）或 `data/postgres/`（PostgreSQL） | 自動備份（見下）＋定期複製到別的地方 |
| 金鑰（JWT、推播 VAPID） | `data/api/jwt_secret`、`data/api/vapid_private.pem` | 一起複製；弄丟會讓所有人重新登入、推播要重新啟用 |
| 設定 | `.env` | 另外保管（含密碼與 Key，不要放進公開的地方） |
| 裝置上的資料 | 每位使用者手機／電腦的 IndexedDB | App 內「設定 → 備份」匯出（可加密）；**收據照片只在裝置上，不在伺服器** |

### 自動備份（SQLite）
API 每天 `CLURE_BACKUP_HOUR` 點之後自動做一份（預設 3 點），保留最近 `CLURE_BACKUP_KEEP` 份（預設 7），放在 `data/api/backups/aster-YYYYMMDD-HHMMSS.db.gz`。

- 用 SQLite online backup：API 運作中也能取得一致的快照；備份完立刻做完整性檢查，有問題就不留檔並記錄錯誤。
- 管理後台 → 總覽 →「資料庫備份」可看狀態與「立即備份」。超過 3 天沒備份會標示警告。
- 指令：

```bash
sudo docker exec clure-api /opt/venv/bin/python -m app.cli backup           # 立即備份
sudo docker exec clure-api /opt/venv/bin/python -m app.cli verify-backup /data/backups/aster-20261031-030000.db.gz
```

> **備份放在同一台機器上不算真的備份。** 請定期（例如每週）把 `data/api/backups/` 複製到另一顆硬碟、另一台機器或雲端（Synology 可用 Hyper Backup 或 Cloud Sync）。

### PostgreSQL
容器內沒有 pg_dump，請從 postgres 容器執行：

```bash
sudo docker exec -t <postgres 容器名> pg_dump -U clure -Fc clure > aster-$(date +%Y%m%d).dump
```

## 2. 還原（SQLite）

1. **先停 API**，避免還原時還有人在寫入：
   ```bash
   sudo docker compose -p aster stop api
   ```
2. 驗證備份檔，然後還原（原本的資料庫會另存為 `clure.db.before-restore`；`--entrypoint` 是因為 api 容器的預設進入點會直接啟動伺服器）：
   ```bash
   sudo docker compose -p aster run --rm --no-deps --entrypoint /opt/venv/bin/python api -m app.cli verify-backup /data/backups/aster-20261031-030000.db.gz
   sudo docker compose -p aster run --rm --no-deps --entrypoint /opt/venv/bin/python api -m app.cli restore /data/backups/aster-20261031-030000.db.gz --yes
   ```
3. 啟動 API，確認就緒：
   ```bash
   sudo docker compose -p aster up -d
   curl -s http://127.0.0.1:9122/api/health/ready
   ```
4. 各裝置打開 App 會自動與伺服器同步；裝置上多出來的資料會重新上傳，不會遺失。

**演練：** 建議每季至少做一次「還原到另一個資料夾、確認能開」的演練，備份才算數。

## 3. 升級與回復

- 升級：把新的 `aster-nas.zip` 傳到 NAS，`unzip -o` 覆蓋後 `sudo docker compose -p aster up -d`；前端自動重新建置，後端自動套用資料庫遷移。
- **升級前先備份**（`app.cli backup`）。遷移是往前的，回復舊版本前請先還原升級前的備份。
- 如果容器卻看不到新檔案（Synology 解壓縮會重建資料夾，容器還掛著舊的）：`sudo docker compose -p aster up -d --force-recreate`。

## 4. 監控

| 端點 | 用途 |
|---|---|
| `GET /api/health` | 輕量存活檢查（Docker healthcheck 用），永遠很快 |
| `GET /api/health/ready` | 就緒檢查：資料庫可連線、遷移是最新、備份是否過期；不就緒時回 503，可接 Uptime Kuma 等監控 |

```bash
curl -s http://127.0.0.1:9122/api/health/ready
sudo docker logs --tail 50 clure-api
sudo docker ps --format "table {{.Names}}\t{{.Status}}" | grep clure
```

## 5. 常見狀況
| 症狀 | 處理 |
|---|---|
| `clure-api` 一直重啟、日誌說 `/app/app does not exist` | 容器掛載到被刪掉的舊資料夾：`up -d --force-recreate` |
| 登入後一切 401／同步失敗 | `ready` 是否 503？看 `docker logs clure-api`；多半是遷移或環境變數 |
| 報價更新失敗 | 設定 → 股票與資料源 →「診斷各資料源」 |
| 推播收不到 | 設定 → 通知與提醒 → 傳送測試推播（訊息會寫出原因） |
| 管理員密碼忘了 | `docker exec clure-api /opt/venv/bin/python -m app.cli create-admin --username <名稱> --email <信箱>`（CLURE_NEW_PASSWORD 提供新密碼） |

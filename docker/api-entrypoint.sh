#!/bin/sh
# ─────────────────────────────────────────────────────────────
# Clure API 熱更新啟動腳本（api 容器，python:3.12-slim）
#   - 原始碼掛載於 /app（= 專案的 server/ 資料夾），覆蓋 .py 檔後 uvicorn 自動重新載入
#   - 套件裝在資料卷 /opt/venv；requirements.txt 有變更時自動重新安裝並重啟
#   - 資料庫遷移在應用程式啟動（含每次重新載入）時自動執行
#   - 以 PUID:PGID 執行（預設 1000:1000，Synology 一般為 1026:100），資料夾權限自動修正
# ─────────────────────────────────────────────────────────────
set -eu

APP_DIR=/app
VENV=/opt/venv
DATA_DIR="${CLURE_DATA_DIR:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
REQ="$APP_DIR/requirements.txt"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [api] $*"; }

req_hash() { sha256sum "$REQ" 2>/dev/null | cut -d' ' -f1; }

install_deps() {
  want="$(req_hash)"
  have="$(cat "$VENV/.req-hash" 2>/dev/null || true)"
  if [ -x "$VENV/bin/uvicorn" ] && [ "$want" = "$have" ]; then
    return 0
  fi
  log "安裝 Python 套件…"
  [ -x "$VENV/bin/python" ] || python -m venv "$VENV" || return 1
  "$VENV/bin/pip" install --disable-pip-version-check --no-cache-dir -q -r "$REQ" || return 1
  echo "$want" > "$VENV/.req-hash"
  log "套件安裝完成"
}

mkdir -p "$DATA_DIR"
chown -R "$PUID:$PGID" "$DATA_DIR"
install_deps

CHILD=""
start_api() {
  log "啟動 API（熱重載：覆蓋 server/app 內的 .py 檔即自動生效）"
  setpriv --reuid="$PUID" --regid="$PGID" --clear-groups \
    "$VENV/bin/uvicorn" app.main:app \
      --host 0.0.0.0 --port 8000 \
      --proxy-headers --forwarded-allow-ips='*' \
      --reload --reload-dir "$APP_DIR/app" --reload-dir "$APP_DIR/alembic" &
  CHILD=$!
}

stop_api() {
  if [ -n "$CHILD" ] && kill -0 "$CHILD" 2>/dev/null; then
    kill -TERM "$CHILD" 2>/dev/null || true
    wait "$CHILD" 2>/dev/null || true
  fi
  CHILD=""
}

trap 'log "停止中…"; stop_api; exit 0' TERM INT

cd "$APP_DIR"
start_api
last="$(req_hash)"
# 監看 requirements.txt：有變更就重新安裝並重啟；API 意外結束也自動重啟
while true; do
  sleep 10 &
  wait $! || true
  now="$(req_hash)"
  if [ "$now" != "$last" ]; then
    log "requirements.txt 已變更"
    stop_api
    install_deps || log "套件安裝失敗，沿用原本的套件（修正 requirements.txt 後會再試）"
    last="$now"
    start_api
  elif ! kill -0 "$CHILD" 2>/dev/null; then
    log "API 已結束，5 秒後重新啟動"
    sleep 5
    start_api
  fi
done

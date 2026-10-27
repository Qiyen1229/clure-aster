#!/bin/sh
# ─────────────────────────────────────────────────────────────
# Aster nginx 啟動腳本（web 容器）
#   覆蓋 docker/nginx.conf 或 docker/security-headers.conf 後，自動檢查語法並重新載入（不中斷連線）
#   語法有錯時保留目前設定繼續服務，修正檔案後會再試
# ─────────────────────────────────────────────────────────────
CONF="/etc/nginx/conf.d/default.conf /etc/nginx/snippets/security-headers.conf"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [web] $*"; }
sig() { cat $CONF 2>/dev/null | md5sum | cut -d' ' -f1; }

nginx -g 'daemon off;' &
PID=$!
trap 'nginx -s quit 2>/dev/null; wait $PID; exit 0' TERM INT

last="$(sig)"
while kill -0 "$PID" 2>/dev/null; do
  sleep 5 &
  wait $! || true
  now="$(sig)"
  if [ "$now" != "$last" ]; then
    last="$now"
    if nginx -t >/dev/null 2>&1; then
      nginx -s reload && log "nginx 設定已更新並重新載入"
    else
      log "nginx 設定語法有誤，保留目前設定：$(nginx -t 2>&1 | tail -2 | tr '\n' ' ')"
    fi
  fi
done
wait $PID

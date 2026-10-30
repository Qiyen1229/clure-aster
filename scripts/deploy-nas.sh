#!/bin/sh
# 一行指令部署到 NAS：打包 → 傳過去 → 就地解壓縮覆蓋 → 套用設定。全部在終端機完成，不用開 DSM 圖形介面。
#   用法：npm run deploy:nas            （預設 ssh 別名 nas、資料夾 /volume1/docker/Aster）
#         NAS_HOST=Qiyen@192.168.1.10 NAS_DIR=/volume1/docker/Aster npm run deploy:nas
# 說明：
#   - 「就地」覆蓋檔案（不先刪資料夾），掛載進容器的資料夾不會被重建，不會出現容器看不到新檔案的問題
#   - 打包檔不含 .env 與 data/，所以你的設定與資料不受影響
#   - 遠端會要求輸入一次 sudo 密碼（重新啟動容器需要）
set -eu

HOST="${NAS_HOST:-nas}"
DIR="${NAS_DIR:-/volume1/docker/Aster}"
PROJECT="${NAS_PROJECT:-aster}"
cd "$(dirname "$0")/.."

echo "▶ 打包…"
sh scripts/pack-nas.sh

echo "▶ 傳送到 $HOST:$DIR …"
scp -q aster-nas.zip "$HOST:$DIR/aster-nas.zip"

echo "▶ 在 NAS 上解壓縮覆蓋並套用（可能要輸入 sudo 密碼）…"
# -t：讓 sudo 能互動輸入密碼。優先用 unzip；NAS 沒有 unzip 時改用 python 容器內的 zipfile（就地覆蓋，不重建資料夾）
ssh -t "$HOST" "set -e; cd '$DIR';
  if command -v unzip >/dev/null 2>&1; then unzip -oq aster-nas.zip;
  else sudo docker run --rm -v '$DIR':/d python:3.12-slim python -c \"import zipfile;zipfile.ZipFile('/d/aster-nas.zip').extractall('/d')\"; fi;
  rm -f aster-nas.zip;
  sudo docker compose -p '$PROJECT' up -d;
  sleep 8;
  sudo docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'NAMES|clure'"
echo "✅ 完成。前端重新建置約需 30～90 秒；若有 unhealthy，用：ssh $HOST 'sudo docker logs --tail 30 clure-api'"

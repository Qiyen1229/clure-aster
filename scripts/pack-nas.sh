#!/bin/sh
# 打包 NAS 更新檔 clure-nas.zip：只含原始碼與設定範本。
# 刻意「不含」.env 與 data/：解壓縮覆蓋到 NAS 資料夾時，不會蓋掉你的設定、資料庫與 JWT 金鑰。
#   用法：sh scripts/pack-nas.sh   → 產生 ./clure-nas.zip
set -eu
cd "$(dirname "$0")/.."
OUT="clure-nas.zip"
rm -f "$OUT"
# 已追蹤＋未追蹤但未被 .gitignore 排除的檔案；再保險排除 .env、data/、打包檔本身（.env.example 另外加回）
FILES=$(git ls-files --cached --others --exclude-standard | grep -v -E '^(\.env|data/|server/data/|clure-nas\.)' ; echo .env.example)
# shellcheck disable=SC2086
printf '%s\n' $FILES | sort -u | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done | zip -q -X "$OUT" -@
echo "已產生 $OUT（$(du -h "$OUT" | cut -f1)），不含 .env 與 data/"
unzip -l "$OUT" | grep -E '(^|/)\.env$|data/api/clure' && { echo '錯誤：打包檔含有 .env 或資料庫' >&2; exit 1; } || true

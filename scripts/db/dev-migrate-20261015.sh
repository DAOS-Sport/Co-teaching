#!/bin/bash
# Apply the app_log migration to the DEVELOPMENT database only.
# Stops without changing anything if dev's schema differs from production's.
set -uo pipefail
cd "$(dirname "$0")"
MIG=../../migrations/manual/20261015_app_log.sql
psql "$DATABASE_URL" -At -f fingerprint.sql | grep "^public." > /tmp/ct-dev-before.txt || { echo "無法讀取 dev 資料庫結構，未做任何變更"; exit 1; }
if ! diff -q prod-fingerprint-20261015.txt /tmp/ct-dev-before.txt > /dev/null; then
  echo "【停止】dev 和正式庫的 public 結構不同，未做任何變更。差異如下（< 正式庫, > dev）："
  diff prod-fingerprint-20261015.txt /tmp/ct-dev-before.txt
  exit 1
fi
echo "dev 與正式庫的 public 結構一致（$(wc -l < /tmp/ct-dev-before.txt) 張表），開始套用 migration…"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$MIG" || { echo "【失敗】migration 已整批回滾，未做任何變更"; exit 1; }
psql "$DATABASE_URL" -At -f fingerprint.sql | grep "^public." > /tmp/ct-dev-after.txt
echo "== 套用後的差異（應只有 1 張新表 public.app_log）"
diff /tmp/ct-dev-before.txt /tmp/ct-dev-after.txt
echo "完成"

#!/bin/bash
# Usage: bash scripts/db/dev-seed-20261014.sh        (create test data)
#        bash scripts/db/dev-seed-20261014.sh clean  (remove it)
# DEVELOPMENT database only: refuses to run against the production database.
set -uo pipefail
cd "$(dirname "$0")"
[ -n "${DATABASE_URL:-}" ] || { echo "找不到 DATABASE_URL，未做任何變更"; exit 1; }
# Refuse the production database (compared by a hash of its host name).
DB_HOST=${DATABASE_URL#*@}
DB_HOST=${DB_HOST%%[/:?]*}
if [ "$(printf %s "$DB_HOST" | sha256sum | cut -c1-16)" = "0f96d3c1c33cf8af" ]; then
  echo "【停止】這是正式資料庫，測試資料只能建在 dev"; exit 1
fi
FILE=dev-seed-20261014.sql
[ "${1:-}" = "clean" ] && FILE=dev-seed-20261014-clean.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$FILE" || { echo "【失敗】已整批回滾，未做任何變更"; exit 1; }
echo "完成"

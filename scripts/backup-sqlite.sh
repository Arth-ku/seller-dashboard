#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/lwarm/apps/seller-dashboard"
DB_PATH="$APP_DIR/data/seller_dashboard.db"
BACKUP_ROOT="/srv/seller-dashboard-backup"
BACKUP_DIR="${SELLER_SQLITE_BACKUP_DIR:-$BACKUP_ROOT/sqlite/daily}"
STAMP="$(date +%Y%m%d)"
BACKUP_PATH="$BACKUP_DIR/seller_dashboard-$STAMP.db"
TEMP_PATH="$BACKUP_DIR/.seller_dashboard-$STAMP.$$.tmp"

cleanup() {
  rm -f "$TEMP_PATH"
}
trap cleanup EXIT

if ! findmnt -rn --mountpoint "$BACKUP_ROOT" >/dev/null; then
  echo "Backup partition is not mounted at $BACKUP_ROOT" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  echo "Database not found: $DB_PATH" >&2
  exit 1
fi

sqlite3 -cmd ".timeout 30000" "$DB_PATH" ".backup '$TEMP_PATH'"
sqlite3 "$TEMP_PATH" "PRAGMA integrity_check;" | grep -qx "ok"
mv "$TEMP_PATH" "$BACKUP_PATH"

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'seller_dashboard-*.db' -mtime +30 -delete

echo "Created SQLite backup: $BACKUP_PATH"

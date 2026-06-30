#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/lwarm/apps/seller-dashboard"
DB_PATH="$APP_DIR/data/seller_dashboard.db"
BACKUP_DIR="$APP_DIR/data/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="$BACKUP_DIR/seller_dashboard-$STAMP.db"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  echo "Database not found: $DB_PATH" >&2
  exit 1
fi

sqlite3 "$DB_PATH" ".backup '$BACKUP_PATH'"
sqlite3 "$BACKUP_PATH" "PRAGMA integrity_check;" | grep -qx "ok"

find "$BACKUP_DIR" -type f -name 'seller_dashboard-*.db' -mtime +14 -delete

echo "Created SQLite backup: $BACKUP_PATH"

#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/lwarm/apps/seller-dashboard"
PUBLIC_DIR="/var/www/authenticitycheck"
BACKUP_ROOT="/srv/seller-dashboard-backup"
CURRENT_DIR="$BACKUP_ROOT/current"
SQLITE_ROOT="$BACKUP_ROOT/sqlite"
HOURLY_DIR="$SQLITE_ROOT/hourly"
DAILY_DIR="$SQLITE_ROOT/daily"
DB_PATH="$APP_DIR/data/seller_dashboard.db"
LOCK_PATH="$BACKUP_ROOT/.backup.lock"
STAMP="$(date +%Y%m%d-%H%M%S)"
DAY="$(date +%Y%m%d)"
SNAPSHOT_NAME="seller_dashboard-$STAMP.db"
SNAPSHOT_PATH="$HOURLY_DIR/$SNAPSHOT_NAME"
TEMP_PATH="$SNAPSHOT_PATH.tmp"

if ! findmnt -rn --mountpoint "$BACKUP_ROOT" >/dev/null; then
  echo "Backup partition is not mounted at $BACKUP_ROOT" >&2
  exit 1
fi

mkdir -p \
  "$CURRENT_DIR/data" \
  "$CURRENT_DIR/uploads" \
  "$CURRENT_DIR/public-static" \
  "$HOURLY_DIR"
install -d -o lwarm -g lwarm -m 0755 "$DAILY_DIR"

exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  echo "Another seller dashboard NVMe backup is already running." >&2
  exit 0
fi

cleanup() {
  rm -f "$TEMP_PATH"
}
trap cleanup EXIT

# Older installations stored hourly snapshots directly under sqlite/. Move them
# into the layered layout before applying retention.
shopt -s nullglob
legacy_snapshots=("$SQLITE_ROOT"/seller_dashboard-????????-??????.db)
for legacy_path in "${legacy_snapshots[@]}"; do
  mv "$legacy_path" "$HOURLY_DIR/$(basename "$legacy_path")"
done

# Build one hard-linked restore point per day from all retained hourly files.
# Iteration is chronological, so each day points to its latest hourly snapshot.
hourly_snapshots=("$HOURLY_DIR"/seller_dashboard-????????-??????.db)
for hourly_path in "${hourly_snapshots[@]}"; do
  hourly_name="$(basename "$hourly_path")"
  hourly_day="${hourly_name#seller_dashboard-}"
  hourly_day="${hourly_day%%-*}"
  ln -f "$hourly_path" "$DAILY_DIR/seller_dashboard-$hourly_day.db"
done

if [ -f "$DB_PATH" ]; then
  sqlite3 -cmd ".timeout 30000" "$DB_PATH" ".backup '$TEMP_PATH'"
  sqlite3 "$TEMP_PATH" "PRAGMA integrity_check;" | grep -qx "ok"
  mv "$TEMP_PATH" "$SNAPSHOT_PATH"
  ln -f "$SNAPSHOT_PATH" "$DAILY_DIR/seller_dashboard-$DAY.db"
  ln -sfn "hourly/$SNAPSHOT_NAME" "$SQLITE_ROOT/latest.db"
fi

# Keep detailed recovery points for one week and one restore point per day for
# one month. Daily files are hard links, so overlapping retention uses no extra
# space until the hourly name is removed.
find "$HOURLY_DIR" -maxdepth 1 -type f -name 'seller_dashboard-*.db' -mtime +7 -delete
find "$DAILY_DIR" -maxdepth 1 -type f -name 'seller_dashboard-*.db' -mtime +30 -delete

# data/backups is deliberately excluded: those restore points already live in
# sqlite/daily and mirroring them would duplicate tens of gigabytes.
rsync -a --delete --delete-excluded --exclude '/backups' "$APP_DIR/data/" "$CURRENT_DIR/data/"
rsync -a --delete "$APP_DIR/uploads/" "$CURRENT_DIR/uploads/"

if [ -d "$PUBLIC_DIR" ]; then
  rsync -a --delete "$PUBLIC_DIR/" "$CURRENT_DIR/public-static/"
fi

date --iso-8601=seconds > "$BACKUP_ROOT/last-success.txt"
echo "Seller dashboard NVMe backup completed at $(cat "$BACKUP_ROOT/last-success.txt")"

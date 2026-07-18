# Seller Dashboard Storage Layout

This file is the canonical storage and backup contract for the Raspberry Pi host.

## Physical Devices

```text
/dev/mmcblk0p2       System disk, mounted at /
/dev/nvme0n1p1      NVMe backup partition, mounted at /srv/seller-dashboard-backup
/dev/nvme0n1p2      NVMe shared-storage partition, mounted at /srv/shared
```

The two NVMe partitions are on the same physical drive. They are separate filesystems, not
independent hardware backups. Do not place both the only live copy and the only backup copy of
important data on those two partitions.

## Live Data

Keep these paths on the system disk:

```text
/home/lwarm/apps/seller-dashboard/data/seller_dashboard.db
/home/lwarm/apps/seller-dashboard/uploads/
```

The SQLite database is small enough for the system disk and benefits from predictable local
availability. As of July 18, 2026, uploads use about 561 MB. Moving them to the NVMe would save
less than 1 GB while putting live images and their backup on the same physical NVMe device.

Reconsider moving live uploads only when they become materially large. Before doing so, add a
backup on a different physical device or remote destination.

## Backup Layout

```text
/srv/seller-dashboard-backup/current/
  data/             Current data mirror, excluding data/backups
  uploads/          Current image mirror
  public-static/    Current buyer-facing static site mirror

/srv/seller-dashboard-backup/sqlite/
  hourly/           Hourly SQLite restore points, retained for 7 days
  daily/            Latest SQLite restore point for each day, retained for 30 days
  latest.db         Symlink to the newest hourly restore point
```

Daily files are hard links to the latest hourly snapshot for the same day. An hourly and daily
name can reference the same underlying data without consuming space twice.

The app path below is a symlink to the NVMe daily set so dashboard history and health checks keep
their existing path:

```text
/home/lwarm/apps/seller-dashboard/data/backups
  -> /srv/seller-dashboard-backup/sqlite/daily
```

## Schedules

```text
seller-dashboard-nvme-backup.timer
  Hourly.
  Creates and validates an hourly SQLite backup.
  Refreshes today's daily hard link.
  Applies 7-day hourly and 30-day daily retention.
  Mirrors current data, uploads, and public static files.

seller-dashboard-backup.timer
  Every 6 hours.
  Compatibility/safety refresh of today's daily SQLite restore point.
  Writes directly to the NVMe daily directory.
```

Never restore the old 30-minute, 14-day full SQLite snapshot policy under `data/backups/`.
At the current database size it creates tens of gigabytes of redundant files on the system disk.

## Verification

After storage or backup changes, verify:

```bash
findmnt -T /srv/seller-dashboard-backup
sqlite3 /srv/seller-dashboard-backup/sqlite/latest.db "PRAGMA integrity_check;"
systemctl status seller-dashboard-nvme-backup.service --no-pager
systemctl list-timers 'seller-dashboard*backup*' --no-pager
df -hT / /srv/seller-dashboard-backup /srv/shared
```

The expected SQLite integrity result is `ok`.

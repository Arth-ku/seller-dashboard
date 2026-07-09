# CLAUDE.md

This file gives Claude Code the project context needed to modify and operate the live Seller Dashboard safely.

## Project Summary

Seller Dashboard is a small Python + browser JavaScript app running on a Raspberry Pi-style Linux host.

It has two user-facing parts:

- Private dashboard at `/sell/` for importing seller CSV rows, editing inventory, uploading product photos, and editing public product details.
- Public authenticity site at `/` for buyer-facing pages like `/620`, `/apparel`, and `/hvac`.

The app intentionally uses simple infrastructure:

- Python standard-library HTTP server in `server.py`
- Browser JavaScript in `app/` and `cloudflare-auth/`
- SQLite database in `data/seller_dashboard.db`
- Uploaded product images in `uploads/`
- Nginx + Cloudflare Tunnel for public access

## Required Business Context For AI Agents

Before changing import logic, category pages, live item health, sold analysis, ad-spend parsing,
or financial calculations, read:

```text
docs/ai-data-model.md
```

That file is the canonical explanation of the owner's Google Sheet semantics:

- `Archive` means sold/history; non-archived rows are live active listings.
- `Facebook`, `Craiglist`, `Ebay`, and `Mercari` are listing-date columns.
- `Self Expense` is owner cost; treat positive and negative numbers as cost via absolute value.
- `Boost` and `Boost 2` are unstructured ad campaign notes.
- `Description of buyer` may contain delivery, location, travel time, cash/Zelle, and other sales context.
- `Sold Day`, `Sold through`, and `Final Price` drive archived/sold analytics.
- Estimated clean money is `numeric Final Price - abs(Self Expense) - parsed ad spend`.

CSV import must be header-based, not fixed-position. The sheet may add/remove columns such as
`Budget`, and fixed-position parsing has previously shifted business fields.

## Live Paths And Services

Known production setup:

```text
Linux user: lwarm
Repo: /home/lwarm/apps/seller-dashboard
Private app base path: /sell
Private app local URL: http://127.0.0.1:8000/sell/
Public domain: https://authenticitycheck.net
Public static root: /var/www/authenticitycheck
Python service: seller-dashboard.service
Python port: 8000
Environment file: /etc/seller-dashboard/app.env
Nginx service: nginx
Cloudflare Tunnel service: cloudflared
```

Expected environment:

```bash
SELLER_DASHBOARD_HOST=0.0.0.0
SELLER_DASHBOARD_PORT=8000
SELLER_DASHBOARD_BASE_PATH=/sell
SELLER_PUBLIC_ALLOWED_ORIGIN=https://authenticitycheck.net
```

## Important Runtime Data

These folders contain live user data and must not be deleted or overwritten unless the user explicitly asks:

```text
/home/lwarm/apps/seller-dashboard/data/
/home/lwarm/apps/seller-dashboard/uploads/
/var/www/authenticitycheck/
/srv/seller-dashboard-backup/
/srv/shared/
```

Do not run these unless the user clearly asks and understands the risk:

```bash
git reset --hard
git clean -fd
rm -rf data uploads
rm -rf /srv/seller-dashboard-backup /srv/shared
```

Before risky changes, inspect:

```bash
cd /home/lwarm/apps/seller-dashboard
git status --short
du -sh data uploads /srv/seller-dashboard-backup /srv/shared
```

## Repository Map

```text
server.py
  Python HTTP server, API routes, SQLite persistence, upload handling,
  public product API, health API, and health journal logic.

index.html
  Private dashboard shell served under /sell/.

app/
  Private dashboard frontend.
  main.js: most dashboard UI and interactions.
  store.js: API calls for state, health, upload.
  csv.js: CSV parsing/serialization and row normalization.
  styles.css: private dashboard styling.
  health.js, health.css: health page UI.

cloudflare-auth/
  Public authenticity frontend served from /var/www/authenticitycheck.
  Changes here must be copied to /var/www/authenticitycheck before they
  appear publicly.

scripts/
  backup-sqlite.sh: SQLite-only backup timer target.
  health-journal.py: periodic health journal recorder.
  site-health-dashboard.py: local desktop/Tk health dashboard.

deploy/
  Example systemd, Nginx, Cloudflare, and Raspberry Pi deployment files.
```

## Routes

Private dashboard:

```text
/sell/
/sell/620
/sell/620/authenticity
/sell/health
```

Private API:

```text
GET  /sell/api/state
PUT  /sell/api/state
POST /sell/api/upload
GET  /sell/api/health
GET  /sell/api/health/journal/latest
GET  /sell/api/health/journal/today
GET  /sell/api/health/journal?date=YYYY-MM-DD
```

Public pages:

```text
/
/620
/apparel
/hvac
```

Public API:

```text
/sell/api/public/products/620
/sell/api/public/apparel
/sell/api/public/hvac
```

## Current Backup And Storage Setup

The NVMe disk is split into two ext4 partitions:

```text
/srv/seller-dashboard-backup  Seller Dashboard backup partition, about 117G
/srv/shared                   Shared storage partition, about 117G
```

Persistent mounts are configured in `/etc/fstab` by UUID.

Backup jobs:

```text
seller-dashboard-backup.timer
  Existing SQLite-only backup job.
  Stores small database snapshots under data/backups/.

seller-dashboard-nvme-backup.timer
  Hourly mirror backup job installed on the host.
  Mirrors data/, uploads/, and /var/www/authenticitycheck into
  /srv/seller-dashboard-backup/current/.
  Also stores SQLite snapshots under /srv/seller-dashboard-backup/sqlite/.
```

The health page intentionally reports both:

```text
Database backups       small SQLite-only snapshots
NVMe backup mirror     full mirror including uploads/images and public static files
```

Shared storage:

```text
Samba share name: SharedStorage
Path: /srv/shared
Mac URL: smb://192.168.1.213/SharedStorage
Windows path: \\192.168.1.213\SharedStorage
User: lwarm
```

Do not write passwords into this file.

## Common Commands

Run health checks:

```bash
cd /home/lwarm/apps/seller-dashboard
systemctl is-active seller-dashboard nginx cloudflared
systemctl list-timers 'seller-dashboard*' --no-pager
curl -s http://127.0.0.1:8000/sell/api/health
curl -s http://127.0.0.1:8000/sell/api/health/journal/today
```

Check logs:

```bash
sudo systemctl status seller-dashboard --no-pager
sudo journalctl -u seller-dashboard -n 80 --no-pager
sudo systemctl status nginx --no-pager
sudo journalctl -u nginx -n 80 --no-pager
sudo systemctl status cloudflared --no-pager
sudo journalctl -u cloudflared -n 80 --no-pager
```

Restart after Python/server changes:

```bash
sudo systemctl restart seller-dashboard
```

Deploy public frontend changes:

```bash
sudo rsync -av --delete /home/lwarm/apps/seller-dashboard/cloudflare-auth/ /var/www/authenticitycheck/
sudo systemctl restart nginx
```

Verify public routing locally:

```bash
curl -H "Host: authenticitycheck.net" http://127.0.0.1/
curl -H "Host: authenticitycheck.net" http://127.0.0.1/620
curl -H "Host: authenticitycheck.net" http://127.0.0.1/sell/api/public/products/620
```

## Development Checks

Python syntax:

```bash
python3 -m py_compile server.py scripts/site-health-dashboard.py scripts/health-journal.py
```

Frontend syntax:

```bash
node --check app/main.js
node --check app/store.js
node --check app/csv.js
node --check app/health.js
node --check cloudflare-auth/main.js
```

Basic live check:

```bash
curl -s -o /tmp/seller-dashboard-index-check.html -w '%{http_code}\n' http://127.0.0.1:8000/sell/
curl -s -o /tmp/seller-dashboard-health-check.json -w '%{http_code}\n' http://127.0.0.1:8000/sell/api/health
```

## Modification Notes

Private dashboard changes usually go in:

```text
app/main.js
app/store.js
app/csv.js
app/styles.css
index.html
```

Public buyer page changes usually go in:

```text
cloudflare-auth/main.js
cloudflare-auth/styles.css
cloudflare-auth/index.html
```

Server/API/storage changes usually go in:

```text
server.py
```

Health page changes usually go in:

```text
server.py
app/health.js
app/health.css
health.html
scripts/site-health-dashboard.py
scripts/health-journal.py
```

When changing public frontend files, update cache-busting query strings in `cloudflare-auth/index.html` when needed so mobile/Opera browsers do not keep stale JS/CSS.

## Refresh Controls

The dashboard does not expose browser CSV import/export controls. The `Refresh now` button calls
the authenticated server-side Google Sheet import endpoint immediately; the scheduled timer still
runs every 5 minutes.

## Admin Login (server-side) And Hidden Items

Shipped in release `v1.1.0`.

- Setting `SELLER_ADMIN_PASSWORD` in `/etc/seller-dashboard/app.env` gates the dashboard behind a
  login. Sign in once; a signed `sd_admin` cookie (~10-year max-age, derived from the password)
  keeps the session. Gated routes: `GET/PUT /sell/api/state` and `POST /sell/api/upload`. Open
  routes: `/api/session`, `/api/login`, `/api/logout`, `/api/ping`, `/api/health`, and all
  `/api/public/*`. If the password is unset, the app runs open (previous behaviour).
- `server.py` also reads a local git-ignored `.env` next to it, so a manual `python3 server.py`
  picks up the password without exporting it. On the Pi, systemd's `EnvironmentFile` still supplies it.
- Each row has a `hidden` boolean (a Hidden column in the table + a checkbox on the product page),
  separate from `archived`. When true, `/api/public/products/{id}` returns 404 and the item is
  dropped from `/api/public/apparel` and `/api/public/hvac`, so the public site cannot see it. It is
  app-only (not part of the CSV schema), so CSV and Google Sheet imports must preserve the existing
  hidden value for matching Box IDs instead of resetting it.

## Data Behavior Rules

CSV import should preserve existing photos and product descriptions for the same box ID. Item names and row fields may update from the imported CSV.

Image files should be managed through the app where possible. Be careful with cleanup logic in `server.py`; deleting or moving files under `uploads/` can break public product pages.

Public authenticity pages should expose only buyer-safe fields:

- title
- description
- price
- item name
- uploaded images

Do not expose private notes, buyer details, or full private dashboard rows publicly.

## Working Style For Claude Code

Prefer small targeted edits. Keep the app simple and Raspberry Pi-friendly.

Before editing, inspect the relevant file and `git status --short`.

After editing, run the smallest useful verification:

- Python edits: `python3 -m py_compile ...`
- JS edits: `node --check ...`
- Server edits: restart `seller-dashboard` and query `/sell/api/health`
- Public frontend edits: copy `cloudflare-auth/` to `/var/www/authenticitycheck` and verify with local `Host: authenticitycheck.net` curls

When reporting back to the user, include exact paths changed and exact commands/results that matter.

# Codex Project Notes

This file is for Codex CLI or any future coding agent working on the Raspberry Pi deployment.

## Project Summary

This is a lightweight Seller Dashboard and public authenticity-check site.

The private dashboard lets the owner import a seller CSV, edit product rows, upload product photos, reorder/delete photos, and edit public title/description data per box ID.

The public site shows authenticity pages for buyers. Public URLs are simple, for example:

```text
https://authenticitycheck.net/620
https://authenticitycheck.net/apparel
https://authenticitycheck.net/hvac
```

## AI Data Model And Business Semantics

Before changing CSV import, Google Sheet automation, inventory categories, live item health,
sold-item analytics, ad-spend parsing, or financial calculations, read:

```text
docs/ai-data-model.md
```

That file explains what every important Google Sheet column means, including:

- `Archive` as sold/history vs live inventory.
- `Facebook`, `Craiglist`, `Ebay`, and `Mercari` as platform listing-date columns.
- `Self Expense` as item cost, using absolute value even when the minus sign is missing.
- `Boost` and `Boost 2` as manually written ad campaign notes.
- `Description of buyer` as unstructured delivery/location/payment data.
- `Sold Day`, `Sold through`, and `Final Price` as sold-analysis fields.
- Clean-money formula: `Final Price - abs(Self Expense) - parsed Boost spend`.

CSV imports must map by header name, not fixed column position. The Google Sheet has changed
columns before, and fixed-position parsing caused shifted data.

## Live Raspberry Pi Setup

Known production Raspberry Pi details:

```text
Linux user: lwarm
App repo: /home/lwarm/apps/seller-dashboard
Public static root: /var/www/authenticitycheck
Python systemd service: seller-dashboard.service
Cloudflare domain: authenticitycheck.net
Python app port: 8000
Python app base path: /sell
Environment file: /etc/seller-dashboard/app.env
```

Expected `/etc/seller-dashboard/app.env` shape:

```bash
SELLER_DASHBOARD_HOST=0.0.0.0
SELLER_DASHBOARD_PORT=8000
SELLER_DASHBOARD_BASE_PATH=/sell
SELLER_PUBLIC_ALLOWED_ORIGIN=https://authenticitycheck.net
SELLER_ADMIN_PASSWORD=<secret>   # dashboard admin login; never commit the real value
```

## Admin login and hidden items

- Setting `SELLER_ADMIN_PASSWORD` gates the dashboard behind a login. Sign in once; a signed
  `sd_admin` cookie (~10-year max-age, derived from the password) keeps you signed in. The
  gated routes are `GET/PUT /api/state` and `POST /api/upload`; `/api/session`, `/api/login`,
  `/api/logout`, `/api/ping`, `/api/health` and the public product/catalog APIs stay open.
- If the password is unset, the app runs open (previous behaviour). `server.py` also loads a
  local `.env` next to it (git-ignored) so `python3 server.py` picks up the password without
  exporting it; on the Pi the systemd `EnvironmentFile` supplies it instead.
- Each row has a `hidden` boolean (a Hidden column in the table and a checkbox on the product
  page), separate from `archived`. When true, `/api/public/products/{id}` returns 404 and the
  item is dropped from `/api/public/apparel` and `/api/public/hvac`, so the public authenticity
  site can't see it. It is app-only (not part of the CSV schema), so CSV and Google Sheet imports
  must preserve the existing hidden value for matching Box IDs instead of resetting it.
- The dashboard does not expose browser CSV import/export controls. Use `Refresh now` to trigger
  the server-side Google Sheet import immediately; the scheduled timer still runs every 5 minutes.

## Repo Structure

Important files and folders:

```text
server.py                  Python HTTP server, API, SQLite storage, uploads
index.html                 Private dashboard shell served under /sell/
app/                       Private seller dashboard frontend
cloudflare-auth/           Public authenticity website frontend
cloudflare-auth/assets/    Public startup video assets
cloudflare-auth/vendor/    Vendored browser libraries, including jsQR
data/                      SQLite DB folder, ignored by git
uploads/                   Product image storage, ignored by git
deploy/raspberry-pi/       Example Pi deployment configs
```

Do not delete or overwrite `data/` or `uploads/` on the Pi unless the user explicitly asks. They contain the live database and uploaded product photos.

## Runtime Architecture

The Python app runs locally on the Pi:

```text
http://127.0.0.1:8000/sell/
```

Nginx serves two things:

```text
/sell/  -> proxy to http://127.0.0.1:8000/sell/
/       -> static files from /var/www/authenticitycheck
```

Cloudflare Tunnel points the public hostname to Nginx on the Pi:

```text
authenticitycheck.net -> http://localhost:80
```

Because of this split, changes to `cloudflare-auth/` do not appear publicly until they are copied to `/var/www/authenticitycheck`.

## Main Routes

Private dashboard:

```text
http://PI-IP:8000/sell/
http://bluezonee/sell/
https://authenticitycheck.net/sell/
```

Private dashboard product pages:

```text
/sell/620
/sell/620/authenticity
```

Public buyer pages:

```text
/                       Startup video page with search and QR scanner
/620                    Public authenticity page for box 620
/apparel                Public list for box IDs 1000-1100
/hvac                   Public list for box IDs 700-800
```

Public API:

```text
/sell/api/public/products/620
/sell/api/public/apparel
/sell/api/public/hvac
```

Private API:

```text
/sell/api/state
/sell/api/upload
```

## Normal Deploy From GitHub On The Pi

Use these commands after pushing changes from the Mac:

```bash
cd /home/lwarm/apps/seller-dashboard
git pull
sudo systemctl restart seller-dashboard
sudo rsync -av --delete /home/lwarm/apps/seller-dashboard/cloudflare-auth/ /var/www/authenticitycheck/
sudo systemctl restart nginx
```

Restarting `seller-dashboard` is needed for `server.py` changes. It is usually not needed for frontend-only changes, but it is safe.

The `rsync` step is required for public frontend changes because Nginx serves `/var/www/authenticitycheck`, not the repo folder directly.

## Quick Health Checks

Check Python app:

```bash
sudo systemctl status seller-dashboard --no-pager
sudo journalctl -u seller-dashboard -n 80 --no-pager
ss -ltnp | grep 8000
curl http://127.0.0.1:8000/sell/api/state
```

Check Nginx:

```bash
sudo nginx -t
sudo systemctl status nginx --no-pager
sudo journalctl -u nginx -n 80 --no-pager
curl -H "Host: authenticitycheck.net" http://127.0.0.1/
curl -H "Host: authenticitycheck.net" http://127.0.0.1/620
```

Check public API through Nginx:

```bash
curl -H "Host: authenticitycheck.net" http://127.0.0.1/sell/api/public/products/620
curl -H "Host: authenticitycheck.net" http://127.0.0.1/sell/api/public/apparel
curl -H "Host: authenticitycheck.net" http://127.0.0.1/sell/api/public/hvac
```

Check Cloudflare Tunnel:

```bash
sudo systemctl status cloudflared --no-pager
sudo journalctl -u cloudflared -n 80 --no-pager
```

## Common Troubleshooting

If `curl http://127.0.0.1:8000/sell/api/state` fails:

Check `seller-dashboard.service`, inspect the journal, confirm `/etc/seller-dashboard/app.env`, and confirm port `8000` is listening.

If the service exits with a Python import error:

Run it manually to see the full traceback:

```bash
cd /home/lwarm/apps/seller-dashboard
/usr/bin/python3 server.py
```

If the manual run says `Address already in use`, the service is already running and owns port `8000`.

If `/620` loads HTML but images or product data do not show:

Check the public API endpoint first:

```bash
curl -H "Host: authenticitycheck.net" http://127.0.0.1/sell/api/public/products/620
```

If API data has images but browser does not show them, check Nginx proxying for `/sell/uploads/...` and inspect browser cache.

If changes to the public homepage, apparel, hvac, QR scanner, or public product pages do not appear:

Run the `rsync` command from the deploy section, restart Nginx, then hard-refresh the browser.

If QR scanning says unavailable:

Make sure these files exist in `/var/www/authenticitycheck`:

```text
/var/www/authenticitycheck/main.js
/var/www/authenticitycheck/vendor/jsQR.js
```

Also make sure the page is opened over HTTPS. Mobile browsers often block camera access on plain HTTP.

If product pictures disappear after saving another box:

Do not manually move/delete files in `uploads/`. Check the SQLite state and upload folders before changing cleanup logic in `server.py`.

If CSV import updates a product:

The intended behavior is to keep existing photos and descriptions for the same box ID. The item name/title may update from the new CSV when the item name changes.

## Data Safety Rules

Do not run destructive git commands on the Pi unless explicitly requested.

Avoid these unless the user clearly approves:

```bash
git reset --hard
git clean -fd
rm -rf data uploads
```

Before risky changes, inspect:

```bash
git status --short
find data uploads -maxdepth 2 -type f | head
```

The folders `data/` and `uploads/` are ignored by git, so `git pull` will not back them up.

## Development Checks

For frontend JavaScript syntax:

```bash
node --check app/main.js
node --check app/store.js
node --check app/csv.js
node --check cloudflare-auth/main.js
node --check cloudflare-auth/vendor/jsQR.js
```

For Python syntax:

```bash
python3 -m py_compile server.py
```

There is no package manager requirement for the server. It uses Python standard library plus browser-side JavaScript.

## Notes For Future Codex

Prefer small targeted fixes. This app is intentionally simple and should stay easy to operate on a Raspberry Pi.

When changing public frontend files, update cache-busting query strings in `cloudflare-auth/index.html` so Opera/mobile browsers do not keep stale JS/CSS.

When answering the user, include exact Pi commands. The user often copies commands directly into the Raspberry Pi terminal.

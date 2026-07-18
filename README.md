# Seller Dashboard

A lightweight seller inventory app with shared server-side storage, designed to run well on a local computer or a Raspberry Pi.

## What it does

- Imports your seller CSV manually from the dashboard.
- Mirrors the CSV structure and lets you edit rows directly on the site.
- Adds a `Box ID` field so every product can open on its own page, like `/628`.
- Automatically assigns `UNKNOWN1`, `UNKNOWN2`, and so on when a row does not start with a box number.
- Lets you upload up to 30 images per product page with previews.
- Saves custom product `Title` and `Description` per box ID.
- Provides authenticity pages like `/628/authenticity`.
- Stores shared data in SQLite and uploaded files on disk, so multiple devices can see the same information.
- Tracks Amazon orders through review submission, approval, seller refund, and archive on
  `/sell/process`, including 30-day return-window urgency and daily history playback.

## Run locally

1. Open a terminal in this folder.
2. Start the server:

```bash
python3 server.py
```

3. Open the app in a browser:

- Local machine: [http://127.0.0.1:8000](http://127.0.0.1:8000)
- Raspberry Pi or LAN use: `http://YOUR-PI-IP:8000`

If you want the app to live under `/sell/`, run:

```bash
SELLER_DASHBOARD_BASE_PATH=/sell python3 server.py
```

Then open:

- `http://YOUR-PI-IP:8000/sell/`
- or through a hostname on your LAN such as `http://bluezonee:8000/sell/`

## Admin login

Protect the dashboard with a single admin password by setting `SELLER_ADMIN_PASSWORD`:

```bash
SELLER_ADMIN_PASSWORD="your-password" python3 server.py
```

- You sign in once and stay signed in on that device (the session cookie lasts ~10 years).
- The dashboard and all edit/upload APIs then require the login; the public authenticity
  pages/API stay open (they never expose private data).
- `server.py` also reads a local `.env` file next to it (git-ignored), so you can put
  `SELLER_ADMIN_PASSWORD=...` there instead of exporting it each time.
- If `SELLER_ADMIN_PASSWORD` is not set, the dashboard runs open to anyone who can reach it.

### Hiding items from the public

Each item has a **Hidden** toggle (a column in the table and a checkbox on the product page),
separate from **Archive**. When an item is hidden, its public authenticity page and the public
product/catalog APIs return "not found", while you can still see and edit it as admin. Use
Archive for "sold/gone" and Hidden for "don't show this to the public right now".

## Raspberry Pi notes

- The server listens on `0.0.0.0` by default, so other devices on your local network can open it.
- The app can also be mounted under a path prefix like `/sell/` using `SELLER_DASHBOARD_BASE_PATH=/sell`.
- Data is stored in [data](/Users/arthur/Documents/SALE DASHBOARD/data) in `seller_dashboard.db`.
- Uploaded files are stored in [uploads](/Users/arthur/Documents/SALE DASHBOARD/uploads).
- If you want a different port, run:

```bash
SELLER_DASHBOARD_PORT=8080 python3 server.py
```

### Order review process

The private order process page is:

```text
http://YOUR-PI-IP:8000/sell/process
```

It imports the review/refund Google Sheet, prioritizes active units whose reviews are closest to
the estimated 30-day return day, and keeps process history separate from inventory history. The
complete A-Q business contract is in `docs/order-review-process.md`.

- For the exact address `http://bluezonee/sell/` to work without `:8000`, you will usually want a reverse proxy on the Pi listening on port 80 and forwarding `/sell/` to this app, or another service already handling that.
- The hostname `bluezonee` must also resolve on your local network. That usually means router/DNS setup, `hosts` entries, or using `bluezonee.local` with mDNS/Avahi.

## Health journal for bots

The app exposes a manual health page and read-only health JSON for bots and remote checks.

- Manual health page: `https://authenticitycheck.net/sell/health`
- Public bot summary JSON: `https://authenticitycheck.net/sell/api/health/journal/today`
- Latest full health snapshot: `https://authenticitycheck.net/sell/api/health`
- Latest journal entry: `https://authenticitycheck.net/sell/api/health/journal/latest`
- Today's summary for a bot: `https://authenticitycheck.net/sell/api/health/journal/today`
- Specific date: `https://authenticitycheck.net/sell/api/health/journal?date=2026-06-30`

The daily summary returns fields like:

```json
{
  "date": "2026-06-30",
  "status": "ok",
  "message": "all ok",
  "snapshotCount": 96,
  "latestCounts": {"ok": 15, "warn": 0, "bad": 0},
  "problems": []
}
```

If something is wrong, `message` changes to `needs attention` and `problems` lists labels such as service failures, HTTP errors, high temperature, low disk, or stale backups with counts for the day.

From Windows PowerShell:

```powershell
Invoke-RestMethod "https://authenticitycheck.net/sell/api/health/journal/today"
```

OpenClaw can use the same JSON URL and read:

- `message` for `all ok` or `needs attention`
- `latestCounts.bad` for current error quantity
- `latestCounts.warn` for current weird/warning quantity
- `problems` for what was weird during the day

To record automatically every 15 minutes on the Pi:

```bash
sudo install -m 755 scripts/health-journal.py /home/lwarm/apps/seller-dashboard/scripts/health-journal.py
sudo install -m 644 deploy/systemd/seller-dashboard-health-journal.service /etc/systemd/system/
sudo install -m 644 deploy/systemd/seller-dashboard-health-journal.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now seller-dashboard-health-journal.timer
```

Journal files are stored as JSON lines in `data/health-journal/YYYY-MM-DD.jsonl`.

## Lucy autonomous analyst

Lucy has a private dashboard page for autonomous seller-dashboard analysis:

- Dashboard page: `https://authenticitycheck.net/sell/lucy`
- Private API: `GET /sell/api/lucy/insights`
- Publish API: `PUT /sell/api/lucy/insights`
- Tracked insight file: `lucy/insights.json`

Lucy reads inventory rows, product details, unit-health signals, archived sales lessons, and
the health journal. She publishes recommendations to the Lucy page without changing inventory,
customer messages, website content, or service settings.

Run once on the Pi:

```bash
cd /home/lwarm/apps/seller-dashboard
python3 scripts/lucy-analyst.py --write
```

Run once and commit/push the updated tracked insight file:

```bash
cd /home/lwarm/apps/seller-dashboard
python3 scripts/lucy-analyst.py --write --commit --push
```

The commit only happens when `lucy/insights.json` changed, so the GitHub history tracks meaningful
Lucy updates instead of creating empty commits.

To let an external Lucy bot publish through the API, set `LUCY_WRITE_TOKEN` in
`/etc/seller-dashboard/app.env` and send it as either:

```text
X-Lucy-Token: your-token
Authorization: Bearer your-token
```

To run Lucy continuously:

```bash
sudo install -m 644 deploy/systemd/seller-dashboard-lucy-analyst.service /etc/systemd/system/
sudo install -m 644 deploy/systemd/seller-dashboard-lucy-analyst.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now seller-dashboard-lucy-analyst.timer
```

The timer runs every 30 minutes after boot. It writes the private runtime copy in `data/lucy/`,
updates `lucy/insights.json`, commits it, and pushes it if Git credentials are available for the
`lwarm` user.

## Cloudflare split setup

You can keep the dashboard on the Raspberry Pi and publish only the public authenticity pages through Cloudflare.

Recommended shape:

- Private/shared dashboard on the Pi:
  - `http://bluezonee/sell/`
- Public media + public API from the Pi through Cloudflare Tunnel:
  - `https://authenticitycheck.net/sell/`
- Public authenticity frontend on the same public domain:
  - `https://authenticitycheck.net/628`

### Raspberry Pi server for public API

Run the Pi server with:

```bash
SELLER_DASHBOARD_BASE_PATH=/sell \
SELLER_PUBLIC_ALLOWED_ORIGIN=https://authenticitycheck.net \
python3 server.py
```

This enables:

- dashboard UI at `/sell/`
- public product API at `/sell/api/public/products/BOXID`
- image URLs under `/sell/uploads/...`

### Public domain on the Pi

Use Nginx on the Pi so the public domain serves:

- authenticity frontend at `/620`
- seller API and images at `/sell/...`

Example Nginx shape:

```nginx
server {
    listen 80;
    server_name authenticitycheck.net www.authenticitycheck.net;

    client_max_body_size 25m;

    location /sell/ {
        proxy_pass http://127.0.0.1:8000/sell/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }

    location / {
        root /home/pi/apps/seller-dashboard/cloudflare-auth;
        try_files $uri $uri/ /index.html;
    }
}
```

### Cloudflare Tunnel

Use `cloudflared` on the Pi and publish:

- `authenticitycheck.net` -> `http://localhost:80`

Cloudflare Tunnel setup docs:
[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/)
[Set up Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/setup/)

### Notes

- Public authenticity pages only expose title, description, price, item name, and uploaded images.
- They do not expose buyer notes or the private dashboard table.
- The Pi must be online for public images and authenticity data to load.
- The public page route can be kept simple, for example `https://authenticitycheck.net/620`.

## Example configs

Ready-to-edit Raspberry Pi example files are included here:

- [deploy/raspberry-pi/cloudflared-config.example.yml](/Users/arthur/Documents/SALE DASHBOARD/deploy/raspberry-pi/cloudflared-config.example.yml)
- [deploy/raspberry-pi/nginx-bluezonee-sell.example.conf](/Users/arthur/Documents/SALE DASHBOARD/deploy/raspberry-pi/nginx-bluezonee-sell.example.conf)
- [deploy/raspberry-pi/SELLER_DASHBOARD.example.env](/Users/arthur/Documents/SALE DASHBOARD/deploy/raspberry-pi/SELLER_DASHBOARD.example.env)
- [deploy/raspberry-pi/README.md](/Users/arthur/Documents/SALE DASHBOARD/deploy/raspberry-pi/README.md)

## Important notes

- This version uses server-side storage, not browser-only storage.
- If you previously used the older browser-storage version, that old browser data does not automatically move into SQLite.
- To move existing inventory into the shared version, import your CSV again and re-upload any needed images.

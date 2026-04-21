# Seller Dashboard

A lightweight seller inventory app with shared server-side storage, designed to run well on a local computer or a Raspberry Pi.

## What it does

- Imports your seller CSV manually from the dashboard.
- Mirrors the CSV structure and lets you edit rows directly on the site.
- Adds a `Box ID` field so every product can open on its own page, like `/628`.
- Automatically assigns `UNKNOWN1`, `UNKNOWN2`, and so on when a row does not start with a box number.
- Lets you upload up to 9 images per product page with previews.
- Saves custom product `Title` and `Description` per box ID.
- Provides authenticity pages like `/628/authenticity`.
- Stores shared data in SQLite and uploaded files on disk, so multiple devices can see the same information.

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

## Raspberry Pi notes

- The server listens on `0.0.0.0` by default, so other devices on your local network can open it.
- The app can also be mounted under a path prefix like `/sell/` using `SELLER_DASHBOARD_BASE_PATH=/sell`.
- Data is stored in [data](/Users/arthur/Documents/SALE DASHBOARD/data) in `seller_dashboard.db`.
- Uploaded files are stored in [uploads](/Users/arthur/Documents/SALE DASHBOARD/uploads).
- If you want a different port, run:

```bash
SELLER_DASHBOARD_PORT=8080 python3 server.py
```

- For the exact address `http://bluezonee/sell/` to work without `:8000`, you will usually want a reverse proxy on the Pi listening on port 80 and forwarding `/sell/` to this app, or another service already handling that.
- The hostname `bluezonee` must also resolve on your local network. That usually means router/DNS setup, `hosts` entries, or using `bluezonee.local` with mDNS/Avahi.

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

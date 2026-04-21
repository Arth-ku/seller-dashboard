# Raspberry Pi deployment examples

This folder contains example config files for the Raspberry Pi setup.

## Files

- [cloudflared-config.example.yml](/Users/arthur/Documents/SALE DASHBOARD/deploy/raspberry-pi/cloudflared-config.example.yml)
  Publishes the Pi app through Cloudflare Tunnel on a hostname like `media.example.com`.

- [nginx-bluezonee-sell.example.conf](/Users/arthur/Documents/SALE DASHBOARD/deploy/raspberry-pi/nginx-bluezonee-sell.example.conf)
  Makes the app available locally at `http://bluezonee/sell/` without `:8000`.

- [SELLER_DASHBOARD.example.env](/Users/arthur/Documents/SALE DASHBOARD/deploy/raspberry-pi/SELLER_DASHBOARD.example.env)
  Example environment variables for the Python app.

## Intended setup

1. Run the Python app on the Pi on port `8000`.
2. Put Nginx in front of it for local LAN access at `http://bluezonee/sell/`.
3. Run `cloudflared` on the Pi for a public hostname like `https://media.example.com`.
4. Point the Cloudflare Pages authenticity frontend to that public Pi hostname.

## Notes

- The Nginx config is for local network access only.
- The Cloudflare Tunnel config is for public access from the internet.
- You can use both at the same time.

# Cloudflare Authenticity Site

This folder is a static authenticity frontend intended for Cloudflare Pages.

## What it does

- Reads the box ID from a URL like `/628`
- Fetches public authenticity data from your Raspberry Pi server
- Displays public photos, title, description, and price

## Before deploy

Edit [index.html](/Users/arthur/Documents/SALE DASHBOARD/cloudflare-auth/index.html) and set:

```html
window.AUTH_APP_CONFIG = {
  apiBase: "https://media.example.com/sell",
};
```

That `apiBase` should point to the Raspberry Pi hostname exposed through Cloudflare Tunnel.

## Deploy to Cloudflare Pages

Deploy this folder as a static site:

- build command: none
- output directory: `cloudflare-auth`

The included [_redirects](/Users/arthur/Documents/SALE DASHBOARD/cloudflare-auth/_redirects) file makes routes like `/628` work as a single-page app.

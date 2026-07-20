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

Before changing the Amazon order, review, approval, refund, return-window, or TIN-exception
workflow, read:

```text
docs/order-review-process.md
```

Before changing uploads, SQLite backup locations, NVMe retention, mount paths, or storage
cleanup, read:

```text
docs/storage-layout.md
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

## Card Management And Financial Reconciliation

The private Card Management page is:

```text
https://authenticitycheck.net/sell/cards
/sell/cards
```

Its purpose is to reconcile bank-card activity with Amazon orders and the `Operation` sheet,
show which card currently carries Amazon-order money, review unmatched activity, and preserve
an auditable decision trail. Card data is private admin data stored inside the SQLite
`app_state` key `cardManagement`. Never expose it through a public API or public buyer page.

The working Google Sheet is:

```text
https://docs.google.com/spreadsheets/d/1sra7RVshoRgBy2fx7Iy2HGz-s59u-3wwO4kRIpBZpog/edit
```

Do not commit bank statements, exported transactions, order numbers, financial snapshots,
the Google Sheet contents, or SQLite data to GitHub. Only commit application code,
documentation, and import/matching rules.

### Cards and statement identities

Use these canonical labels and aliases:

| Dashboard card | Statement identity or alias |
| --- | --- |
| `Amazon 1045` | Chase card ending `1045`; Amazon purchases and occasional other activity |
| `Sapphire 0185` | Chase Sapphire ending `0185`; travel and general purchases |
| `MS 5276` | Chase statement ending `5276` |
| `Discover 3038` | Discover ending `3038` |
| `Chase Debit 3383` | Checking/debit statement may show account/file ending `7560`; treat `7560` and `3383` as the same account |
| `Apple 7190` | Apple Card ending `7190` |

Other payment methods known from the sheet include `Capital One Debit 2618`, `DIS 6688`, and
`Gift Card`. These three were explicitly excluded from the consolidated `Problem Summary`
exercise unless the owner later changes that rule.

The original statement filename patterns used on the Mac were:

```text
Chase1045_Activity*.CSV
Chase0185_Activity*.CSV
Chase5276_Activity*.CSV
Discover-AllAvailable-*.csv
Chase7560_Activity*.CSV
Apple Card Transactions *.csv
```

The Card Management CSV importer infers a card from the final four digits in the filename.
The original Discover and Apple filenames may not contain `3038` or `7190`; when importing,
use a temporary copy whose filename contains the correct ending. Never alter the original
statement file just to satisfy filename inference.

### Date scopes

Three different date cutoffs have been used and must not be mixed:

- `Problem Summary`: ignore transactions before `2025-03-20`.
- Missing Amazon/AMZN statement charges list: only activity after `2026-03-20`.
- Card Management operational dashboard: starts at `2026-06-11`.

Card Management's start date is persisted and defaults to `2026-06-11`. A posted date,
transaction date, and Amazon order date can differ by several days. Dates are supporting
evidence, not an automatic reason to reject an otherwise strong amount/card/order match.

### Signed amount conventions

Use one unambiguous convention in transaction/problem lists:

- Positive amount = money charged to the card/account.
- Negative amount = refund or credit returned to the card/account.
- An Amazon chargeback/re-charge is a positive Amazon charge, not a refund.

In the `Operation` sheet, `Price Items` remains the positive original item cost. Do not turn
the original price negative to represent a return. Use `Return Status` plus `Refund Amount`.
`Refund Amount` is recorded as a positive magnitude in `Operation`, and:

```text
Net Cost = Price Items - Refund Amount
```

Therefore a full return has `Net Cost = 0`; a partial return has the unreimbursed balance.
In signed transaction/problem tables, the corresponding refund transaction itself is
negative. This difference is intentional.

Do not classify checking-account income, Zelle receipts, Payoneer deposits, credit-card
autopay, statement payments, cashback redemptions, or balance transfers as product refunds.
They may be retained as account activity when useful, but they must have a separate transfer,
payment, or income classification and must not inflate spending/refund KPIs.

### `Operation` sheet columns

The current `Operation` table spans columns `A:U`. Columns have moved before, so always read
the live header row and map by header name. The current meanings are:

| Column | Header | Meaning |
| --- | --- | --- |
| A | blank/row field | Existing sheet-specific field; preserve it |
| B | `LISTED` | Listing state/date as maintained by the owner |
| C | `Seller` | Seller/vendor |
| D | `Account` | Related account |
| E | `Product Name` | Ordered product |
| F | `Special double check` | Manual verification flag/details |
| G | `Order num` | Amazon order number; strongest identity when present |
| H | `Order Date` | Amazon order date; may not equal transaction/post date |
| I | `Tracking` | Shipment/return tracking or related delivery evidence |
| J | `RV POLICY` | Review/reimbursement policy |
| K | `RV submitted` | Review/reimbursement submission date or state |
| L | `RV approved day` | Approval date/state |
| M | `Price Items` | Positive original order/item cost |
| N | `Return Status` | Returned, partial refund, full refund, or other return state |
| O | `Refund Amount` | Positive refund magnitude used to calculate net cost |
| P | `Net Cost` | `Price Items - Refund Amount` |
| Q | `Paid` | Amount/status paid by the seller/reimbursement workflow |
| R | `Pay method` | Canonical card/payment method |
| S | `CHECKED` | Statement reconciliation result; this is column `S`, not the old column `P` |
| T | `Payment Day` | Payment/reimbursement date |
| U | `Review\Notes` | Free-form evidence, review copy, exceptions, and context |

For a confirmed statement match, use a consistent `CHECKED` value such as:

```text
MATCHED – AMAZON 1045
MATCHED – SAPPHIRE 0185
MATCHED – MS 5276
MATCHED – DIS 3038
MATCHED – CHASE DEBIT 3383
MATCHED – APPLE 7190
```

Preserve existing casing when practical. Never overwrite product descriptions, tracking,
review text, seller notes, or reimbursement values while updating financial match fields.

### Matching rules

Use this evidence priority:

1. Exact card/payment method.
2. Exact or explainable amount.
3. Amazon order number when available.
4. Merchant/descriptor such as `AMAZON`, `AMZN`, or `AMAZON MKTPL`.
5. Order date, transaction date, and posted date within a reasonable offset.
6. Tracking, return, refund, gift-card, or owner notes that explain a difference.

Amount is usually stronger than date because transaction and order dates can be wrong or
shifted. A small rounded difference may be accepted only when card, order/date window, and
other evidence make the identity clear. Do not round solely because two amounts are close.

Gift-card use can explain why the card charge is lower than `Price Items`; do not overwrite
the full item price with the card-funded portion unless the owner explicitly resolved it that
way. Split charges, combined Amazon charges, partial refunds, and multiple same-day orders
must be documented rather than force-matched.

When a charge and its refund are equal and clearly related, combine them for problem-summary
purposes and omit the zero-net pair from the final real-problems list. Preserve the underlying
transactions in Card Management for auditability.

### Problem tabs and resolution flow

Card-specific unresolved work belongs in:

```text
Problems             Amazon 1045/general original problem table
Problems 0185        Sapphire 0185
Problem 5276         MS 5276
Problem 3038         Discover 3038
Problem 3383         Chase Debit 3383 / statement alias 7560
Problem 7190         Apple 7190
Problem Summary      consolidated final review
```

Dates in these tabs must be readable dates, never raw Google Sheets serials such as `46043`.

`Problem Summary` contains an owner-decision column named `MY FINAL RW`. Treat `RESOLVED`
there as authoritative. After resolution:

1. Re-check the charge/refund sign.
2. Trace the row back to the exact `Operation` order.
3. Correct `Price Items`, `Return Status`, `Refund Amount`, and `Net Cost` only when the
   resolution supplies evidence for those fields.
4. Set `CHECKED` to `MATCHED – <CARD>`.
5. Do not create fake `Operation` product rows for bank-only activity that has no identified
   order/product.
6. Leave only genuinely unmatched or mismatched amounts in the final problem section.

The consolidated review requested these separate outputs:

- Remaining real problem items after resolved rows and zero-net charge/refund pairs are removed.
- Amazon/AMZN card charges missing from `Operation`.
- Amazon chargebacks/re-charges as a separate positive-charge list.

### Card Management application behavior

The first production Card Management implementation lives in:

```text
app/card-management.js
app/styles.css
app/main.js
app/store.js
server.py
```

It provides:

- date range beginning `2026-06-11`;
- Amazon money held by card;
- unmatched-charge, pending-refund, and confirmed-spend KPIs;
- per-card exposure bars and a review queue;
- card/status/Amazon/search filters;
- add, edit, confirm, flag, and delete actions;
- multi-file CSV statement import and CSV export;
- persistent storage through `/sell/api/state`.

Current transaction status meanings:

| Status | Meaning |
| --- | --- |
| `held` | Amazon charge believed to represent money still tied up in an order; requires reconciliation before considered final |
| `unmatched` | Positive charge not yet linked/confirmed |
| `review` | Evidence conflict or manual decision needed |
| `confirmed` | Charge matched and accepted |
| `refund-pending` | Negative credit/refund not yet fully reconciled |
| `released` | Hold/refund lifecycle is complete and no longer outstanding |

Imported Amazon transactions are initially provisional. Do not assume every historical Amazon
charge is still held merely because the descriptor contains Amazon. Reconcile it against
`Operation`, refunds, and resolved problem rows, then change it to `confirmed` or `released`
as appropriate.

As of `2026-07-20`, the first live import loaded 153 statement transactions dated from
`2026-06-11` onward:

```text
Amazon 1045       63
Sapphire 0185     16
MS 5276            1
Discover 3038      1
Chase Debit 3383  26
Apple 7190        46
```

This is a historical baseline, not a hard-coded expected total. Re-imports must deduplicate by
card, transaction date, signed amount, and normalized merchant/descriptor. Always verify
persistence by reloading `/sell/cards` after import.

### Card Management safety

- Never place real transaction seed data in frontend JavaScript or Git.
- Never overwrite the entire `/api/state` payload with only `cardManagement`; preserve rows,
  product details, metadata, and other state keys.
- Never delete `data/seller_dashboard.db` to reset Card Management.
- Before bulk cleanup, create/verify a SQLite backup and identify transactions by stable keys.
- A statement import must be idempotent and must report skipped duplicates.
- Keep charges and refunds separately auditable even when the problem summary nets them.
- Owner decisions in `MY FINAL RW` and explicit notes override automated confidence scores.

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

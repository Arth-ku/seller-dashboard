# Seller Dashboard AI Data Model

This file records the business meaning of the Google Sheet / CSV fields so future AI agents do not need the owner to explain it again.

## Source Of Truth

- The Google Sheet tab named `Seller Dashboard` is the live source of truth for inventory rows.
- Automated import runs every 5 minutes through `seller-dashboard-google-sheet-import.timer`.
- CSV URL shape:

```text
https://docs.google.com/spreadsheets/d/1nh4HWr8DAP26KziNTMGEtqs6LEkV8-Va9IDo7oTACQw/export?format=csv&gid=1100190800
```

- Imports must map by header name, not fixed column position. The sheet has changed before; for example, `Budget` may be absent. Header-based mapping prevents later columns from shifting.

## Categories

Private dashboard categories:

```text
Units    Box IDs 1-700, 800-999 plus old UNKNOWN / missing Box ID rows
HVAC     Box IDs 700-800
Apparel  Box IDs 1000-1100
```

`/sell/` is a category overview. Category pages are:

```text
/sell/units
/sell/hvac
/sell/apparel
```

Implementation note: category ranges intentionally overlap at owner-defined boundary values (`700` and `800`). Box `1000` belongs to Apparel, not Units. Keep the owner-facing ranges exactly as written above unless the owner changes the business rule. Older rows with blank, non-numeric, or `UNKNOWN...` Box IDs belong in Units so they remain visible and actionable.

`/sell/health-rank` is the full live-inventory health page. It must rank every non-archived row, not only the first few top-risk items shown on category pages.

Items outside those ranges should be surfaced as uncategorized, not silently ignored.

## Historical Sales Analysis

Sold-analysis widgets should support calendar playback by selected year, month, and week number. Do not use day-level date pickers for this workflow. If the user selects a month but does not select a week number, the widget must show the whole selected month. The filter uses `Sold Day` as the sale date and recalculates revenue, estimated net, channel mix, delivery/payment signals, and data cleanup counts for the selected period.

## Core Row State

### Archive

`Archive` / `archived` means the item is sold or otherwise no longer an active sales target.

- `archived = false`: live listing, currently trying to sell.
- `archived = true`: sold/history item, used for analysis.

Do not mix archived and live rows in the same business list. Live rows need action/health analysis. Archived rows need sales-performance analysis.

### Hidden

`hidden` is app-only, not from the CSV. It controls public visibility. Hidden items should not appear in public buyer APIs/pages, but still appear in admin views.

## Column Meanings

### Items Name

Item title/name from the sheet. Usually begins with Box ID for normal items. The app derives `boxId` from a leading number when possible.

### Price listed

Original/current listing price. Use this as the baseline list price.

### Revised

Updated/reduced price. If present and numeric, use it as the active selling price for live inventory.

### Date:

Price changed / listing update date when used. This is not always filled. Prefer platform listing dates for listing age.

### Self Expense

Owner cost for the unit.

- `$0` means free inventory.
- Negative values like `-$12` mean the item cost $12.
- Positive values like `$10` are usually a typo where the owner forgot the minus sign; still treat as a $10 cost.

For clean-money calculation, use `abs(Self Expense)`.

### Facebook, Craiglist, Ebay, Mercari

These are listing date columns for each platform.

- `Facebook`: date listed on Facebook Marketplace.
- `Craiglist`: date listed on Craigslist. Keep the existing misspelling in code/schema as `craiglist`.
- `Ebay`: date listed on eBay.
- `Mercari`: date listed on Mercari.

Some items only fit Facebook/Craigslist and are intentionally blank for eBay/Mercari.

For live inventory age:

1. Use the earliest platform listing date as `listedAt`.
2. Use the latest platform listing/update/boost date as a recent action signal.
3. If no platform dates exist, flag the item as missing a listing date.

### Boost and Boost 2

Ad promotion notes. Treat `Boost 2` exactly like `Boost`; it is overflow space when `Boost` is full.

The text is manually written and inconsistent. Parse best-effort ad campaigns:

```text
6/29/2025 - $6 total, 3 days
7/11/2025 - boost for $3 for 3 days
```

Interpretation:

- Start date: date in the note.
- Duration: number before `day` / `days`.
- If text says `total`, the dollar amount is total campaign cost.
- If text does not say `total`, dollar amount is usually per-day cost. Multiply by duration.
- Campaign end date = start date + duration.

Examples:

```text
6/29/2025 - $6 total, 3 days
```

Cost = $6 total, campaign 6/29 through about 7/2.

```text
7/11/2025 - boost for $3 for 3 days
```

Cost = $9 total, campaign 7/11 through about 7/14.

Boost notes are also useful for live listing health:

- Live item with no boost and old listing age: candidate for small promotion after improving title/photos.
- Live item boosted repeatedly but still unsold: do not blindly keep boosting; change price, photos, title, channel, or bundle.
- Archived item sold during or shortly after a boost: ad likely helped.
- Archived item sold long after a boost: ad probably did not directly close sale.

### Description of buyer

Unstructured buyer and fulfillment notes. Parse for useful signals:

- Delivery vs pickup.
- Location hints, e.g. `NJ`, `Jersey City`, `Brooklyn`, `Staten Island`.
- Travel time, e.g. `20min added total`.
- Payment method, e.g. `cash`, `Zelle`.

Example:

```text
delivery to NJ Jersey City (20min added total), paid by cash
```

Structured interpretation:

- Fulfillment: delivery.
- Location: NJ / Jersey City.
- Travel time: 20 minutes.
- Payment: cash.

### Sold Day

Well-structured sold date. Use this as the date the item sold.

For archived rows, sales speed can be estimated:

```text
sale speed = Sold Day - earliest platform listing date
```

Fast sales are business signals:

- Sold same day or within a few days: product/price/channel likely strong.
- Sold without discount: strong pricing.
- Sold without ad boost: organic demand/channel fit.
- Sold during boost campaign: ad likely effective.

### Sold through

Sales channel. Normalize common values:

```text
fb        -> Facebook
facebook  -> Facebook
craiglist -> Craigslist
craigslist -> Craigslist
ebay      -> eBay
mercari   -> Mercari
```

Analyze sales percentage and revenue by channel. This tells where the owner sells most effectively.

### Final Price

Final money received from the customer. This is gross received amount before subtracting owner cost and ad spend.

Use numeric values only for financial calculations. Non-numeric text like `SOLD AS SET` needs manual cleanup or linked/set-aware handling.

### Notes

General unstructured notes. Also parse for delivery/payment/location/ad-related hints when present.

## Clean Money / Net Formula

For archived sold rows:

```text
gross received = numeric Final Price
self expense = abs(Self Expense)
ad spend = parsed total from Boost + Boost 2
clean money / estimated net = gross received - self expense - ad spend
```

Important:

- If `Final Price` is not numeric, do not invent revenue.
- If a row says `SOLD AS SET`, it may need special handling with another row/set sale.
- Treat parsed ad spend as an estimate because boost notes are manually written.

## Live Item Health

Live rows should be ranked by business urgency. Useful signals:

- Listing age from platform listing date.
- Days since latest action/update/boost.
- No platform listing date.
- Missing numeric active price.
- No uploaded photos.
- Missing custom title/description.
- No boost after long listing age.
- Boosted repeatedly but still unsold.
- Already discounted but still old.

Suggested action logic:

- No price: set a usable price before ads.
- No photos: add photos before ads.
- Missing title/description: improve content before ads.
- Old and no boost: refresh listing, then test small 3-day boost.
- Old and boosted: change price/photos/title/channel; promotion alone is not working.
- Long idle time: relist or update listing copy.

## Archived / Sold Analysis

Archived rows are not operational clutter; they are the business learning set.

Useful rankings:

- Sold winners: fast sale, good net, no discount, no ad needed.
- Channel winners: where units actually sell by count and revenue.
- Ad winners: sold during or shortly after a boost campaign.
- Bad ad lessons: boosted but sale happened much later or needed discount.
- Data cleanup: missing final price, missing sold-through, missing sold day, non-numeric final price.

Use archived data to recommend what kind of live inventory deserves more ad spend and what should be repriced or deprioritized.

## Historical Playback

History exists for day-level playback and is intentionally compact.

- Existing SQLite backups appear as playback days.
- Automated Google Sheet imports coalesce to one snapshot per day.
- Frequent 5-minute imports should not create hundreds of history entries.
- Snapshots store JSON state and reference existing uploaded image files; images are not duplicated.

## Implementation Notes

- Keep CSV import header-based in both `app/csv.js` and `scripts/import-google-sheet-csv.py`.
- Do not assume `Budget` exists.
- Keep `craiglist` spelling in code for compatibility with existing row schema.
- Public catalog APIs use current data only; historical playback is admin-only.
- Category pages must keep live and archived rows separated.

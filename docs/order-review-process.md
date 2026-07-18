# Order Review Process Data Model

This file is the canonical business contract for the purchasing, review, refund, and resale
workflow. Future changes to the order process page or its Google Sheet importer must preserve
these meanings unless the owner changes the rules.

## Source Of Truth

The live source is this Google Sheet:

```text
https://docs.google.com/spreadsheets/d/1nh4HWr8DAP26KziNTMGEtqs6LEkV8-Va9IDo7oTACQw/edit?usp=sharing
```

CSV export used by the importer:

```text
https://docs.google.com/spreadsheets/d/1nh4HWr8DAP26KziNTMGEtqs6LEkV8-Va9IDo7oTACQw/export?format=csv
```

The private operational page is:

```text
/sell/process
```

The importer maps columns by header name, not fixed position. Column A currently has a blank
header in the live export, so index 0 is used only as a compatibility fallback for `Archived`.
Empty Google Sheet grid rows containing only unchecked `FALSE` checkbox values are ignored.

## Business Workflow

1. Order a unit from Amazon.
2. Complete the seller-required review policy.
3. Submit the review to the platform.
4. After the platform approves the review, send the approved review to the seller.
5. Receive the refund from the seller.
6. Sell the unit.
7. Mark the unit archived after the seller payment/refund is received.

Normally a unit should not be listed for resale before review approval. Seller `TIN` is the only
trusted exception: a TIN unit may be listed or sold before review approval. Matching is
case-insensitive after trimming and otherwise exact; do not automatically extend this exception
to other sellers.

## Return Window And Urgency

The estimated return day is:

```text
Order Date + 30 calendar days
```

For return-window protection, a unit is considered processed enough when at least `RV submitted`
has a date. `RV approved` also implies the review was submitted.

Only active, non-archived units without a submitted/approved review receive return-window urgency:

```text
Overdue   estimated return day is in the past
Urgent    0-3 days remaining
Due soon  4-7 days remaining
Watch     8-14 days remaining
On track  more than 14 days remaining
```

A missing or unparseable order date is a data issue. The page must not invent a deadline.

## Column Meanings

### A: Archived

Google Sheet export header is currently blank. Checkbox.

- `TRUE`: the seller payment/refund was received and the unit is complete/history.
- `FALSE`: the unit is still active in the review/refund workflow.

Archive is based on seller payment/refund, not whether the resale unit was sold to a customer.

### B: Listed

Checkbox showing whether the physical unit is listed for resale.

- `TRUE`: listed.
- `FALSE`: not listed.

Listing before review approval is allowed only for seller `TIN`.

### C: Seller

Seller responsible for the review policy and refund.

### D: Account

Amazon account used to place the order.

### E: Product Name

Full title copied from the Amazon order. When review work is complete and the unit is entered
into resale inventory, the beginning of this field may also contain the box ID and sometimes the
physical location.

### F: Special double check

Sheet-owned checkbox that must be preserved and displayed. The owner has not yet supplied a more
specific business rule, so code must not infer one.

### G: Order Number

Amazon order number and intended business identifier for the order. The current sheet contains
some repeated and blank values, so import must preserve every meaningful row instead of
overwriting rows by order number.

### H: Order Date

Date the Amazon order was placed. This drives the estimated 30-day return day.

### I: Tracking

Optional tracking number or delivery/shipping note.

### J: RV POLICY

Seller requirements for the review, such as text review, picture review, video review, self-pay,
or tax not included. `Self-pay` means the owner pays that amount. `Tax not included` means the
owner pays the tax.

### K: RV submitted

Date the review was uploaded/submitted to the platform. Once present, the unit has met the
minimum return-window processing requirement.

### L: RV approved

Date the platform approved the review. After this, send the approved review to the seller for
refund.

### M: Price Items

Final Amazon order price including tax.

### N: Paid

Amount the seller paid/refunded to the owner.

### O: Pay method

Card or payment method used for the Amazon order.

### P: Payment Day

Date the seller payment/refund was received.

### Q: Review / Notes

Optional posted review text and operational notes. Review text helps avoid accidentally posting
duplicate review content.

## Workflow Stages On The Page

For active rows, stage precedence is:

```text
Paid amount or Payment Day present  -> Refund received; confirm and archive
RV approved present                 -> Send approval to seller / follow up for refund
RV submitted present                -> Wait for platform approval
No valid Order Date                 -> Fix the order date
Otherwise                           -> Submit the required review
```

Archived rows are complete and should not clutter the default active queue.

## Import And History

- Manual refresh: `POST /sell/api/order-process/import`.
- Scheduled refresh: the existing five-minute Google Sheet timer runs the order process importer
  after the inventory importer.
- Runtime data is stored in separate SQLite tables: `order_process_state` and
  `order_process_snapshots`.
- Process history is separate from inventory history.
- Automated imports coalesce to the latest process snapshot for each calendar day.
- Full SQLite/NVMe backups include the process tables automatically.
- Historical process views are read-only.

Optional environment overrides:

```text
SELLER_ORDER_PROCESS_SHEET_CSV_URL
SELLER_ORDER_PROCESS_SHEET_NAME
```

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import uuid
from io import StringIO
from pathlib import Path
from urllib.request import Request, urlopen


APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

import server  # noqa: E402


CSV_HEADERS = [
    "Archive",
    "Items Name",
    "Price listed",
    "Revised",
    "Date:",
    "Self Expense",
    "Facebook",
    "Craiglist",
    "Ebay",
    "Mercari",
    "Budget",
    "Boost",
    "Boost 2",
    "Description of buyer",
    "Sold Day:",
    "Sold thruogh",
    "Final Price",
    "Notes",
]

FIELD_ORDER = [
    "archived",
    "itemName",
    "priceListed",
    "revised",
    "priceChangedDate",
    "selfExpense",
    "facebook",
    "craiglist",
    "ebay",
    "mercari",
    "budget",
    "boost",
    "boost2",
    "buyerDescription",
    "soldDay",
    "soldThrough",
    "finalPrice",
    "notes",
]

HEADER_TO_FIELD = {
    "": "archived",
    "archive": "archived",
    "items name": "itemName",
    "item name": "itemName",
    "price listed": "priceListed",
    "revised": "revised",
    "date:": "priceChangedDate",
    "date": "priceChangedDate",
    "self expense": "selfExpense",
    "facebook": "facebook",
    "fb": "facebook",
    "craiglist": "craiglist",
    "craigslist": "craiglist",
    "ebay": "ebay",
    "mercari": "mercari",
    "budget": "budget",
    "boost": "boost",
    "boost 2": "boost2",
    "description of buyer": "buyerDescription",
    "sold day:": "soldDay",
    "sold day": "soldDay",
    "sold thruogh": "soldThrough",
    "sold through": "soldThrough",
    "final price": "finalPrice",
    "notes": "notes",
}


def load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def fetch_csv(url: str) -> str:
    request = Request(url, headers={"User-Agent": "seller-dashboard-import/1.0"})
    with urlopen(request, timeout=60) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def rows_from_csv(text: str) -> list[dict]:
    parsed = [
        [cell.strip() for cell in row]
        for row in csv.reader(StringIO(text))
        if any(cell.strip() for cell in row)
    ]
    if not parsed:
        return []

    has_header = any(
        (parsed[0][index] if index < len(parsed[0]) else "").lower() == expected.lower()
        or bool(header_to_field(parsed[0][index] if index < len(parsed[0]) else "", index))
        for index, expected in enumerate(CSV_HEADERS)
    )
    data_rows = parsed[1:] if has_header else parsed
    return normalize_imported_rows_from_header(data_rows, parsed[0]) if has_header else normalize_imported_rows(data_rows)


def normalize_imported_rows(data_rows: list[list[str]]) -> list[dict]:
    rows: list[dict] = []
    for cells in data_rows:
        row = create_empty_row(rows)

        for index, key in enumerate(FIELD_ORDER):
            raw = cells[index] if index < len(cells) else ""
            row[key] = bool(re.match(r"^true$", raw, re.IGNORECASE)) if key == "archived" else raw

        derived_box_id = extract_leading_box_id(row.get("itemName", ""))
        row["boxId"] = ensure_unique_box_id(derived_box_id or row["boxId"], rows, row["id"])
        row["isDraft"] = False

        if should_remove_row(row):
            continue

        rows.append(row)

    return rows


def normalize_imported_rows_from_header(data_rows: list[list[str]], header_row: list[str]) -> list[dict]:
    field_by_index = [header_to_field(cell, index) for index, cell in enumerate(header_row)]
    rows: list[dict] = []
    for cells in data_rows:
        row = create_empty_row(rows)

        for index, raw in enumerate(cells):
            key = field_by_index[index] if index < len(field_by_index) else ""
            if not key:
                continue
            row[key] = bool(re.match(r"^true$", raw, re.IGNORECASE)) if key == "archived" else raw

        derived_box_id = extract_leading_box_id(row.get("itemName", ""))
        row["boxId"] = ensure_unique_box_id(derived_box_id or row["boxId"], rows, row["id"])
        row["isDraft"] = False

        if should_remove_row(row):
            continue

        rows.append(row)

    return rows


def header_to_field(cell: str, index: int) -> str:
    normalized = str(cell or "").strip().lower()
    if not normalized and index == 0:
        return "archived"
    return HEADER_TO_FIELD.get(normalized, "")


def create_empty_row(existing_rows: list[dict]) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "isDraft": True,
        "boxId": get_next_unknown_box_id([row.get("boxId", "") for row in existing_rows]),
        "archived": False,
        "hidden": False,
        "itemName": "",
        "priceListed": "",
        "revised": "",
        "priceChangedDate": "",
        "selfExpense": "",
        "facebook": "",
        "craiglist": "",
        "ebay": "",
        "mercari": "",
        "budget": "",
        "boost": "",
        "boost2": "",
        "buyerDescription": "",
        "soldDay": "",
        "soldThrough": "",
        "finalPrice": "",
        "notes": "",
    }


def get_next_unknown_box_id(existing_ids: list[str]) -> str:
    used = {str(item or "").upper() for item in existing_ids}
    counter = 1
    while f"UNKNOWN{counter}" in used:
        counter += 1
    return f"UNKNOWN{counter}"


def extract_leading_box_id(item_name: str) -> str:
    match = re.match(r"^\s*(\d+)\b", str(item_name or ""))
    return match.group(1) if match else ""


def sanitize_box_id(value: str) -> str:
    cleaned = re.sub(r"\s+", "-", str(value or "").strip())
    cleaned = re.sub(r"[^a-zA-Z0-9-]", "", cleaned)
    return cleaned.upper()


def ensure_unique_box_id(candidate: str, rows: list[dict], current_row_id: str) -> str:
    base = sanitize_box_id(candidate) or get_next_unknown_box_id([row.get("boxId", "") for row in rows])
    used = {
        str(row.get("boxId") or "").upper()
        for row in rows
        if row.get("id") != current_row_id and str(row.get("boxId") or "").strip()
    }
    if base not in used:
        return base

    suffix = 2
    while f"{base}-{suffix}" in used:
        suffix += 1
    return f"{base}-{suffix}"


def should_remove_row(row: dict) -> bool:
    return not row.get("isDraft") and not has_meaningful_content(row)


def has_meaningful_content(row: dict) -> bool:
    for key in FIELD_ORDER:
        if key == "archived":
            if row.get("archived") is True:
                return True
            continue
        if str(row.get(key) or "").strip():
            return True
    return False


def normalize_comparable_title(value: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^\d+\s*[-:.)#]*(\s*)?", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.upper()


def should_refresh_imported_title(current_title: str, previous_item_name: str, next_item_name: str) -> bool:
    current = normalize_comparable_title(current_title)
    previous = normalize_comparable_title(previous_item_name)
    next_value = normalize_comparable_title(next_item_name)

    if not next_value:
        return False
    if not current:
        return True
    return current == previous


def merge_imported_rows(imported_rows: list[dict], current_state: dict) -> dict:
    current_rows = current_state.get("rows", [])
    product_details = dict(current_state.get("productDetails", {}))
    previous_rows_by_box_id = {
        str(row.get("boxId") or "").upper(): row
        for row in current_rows
        if row.get("boxId")
    }

    for row in imported_rows:
        box_id = str(row.get("boxId") or "").upper()
        if not box_id:
            continue

        previous_row = previous_rows_by_box_id.get(box_id)
        if not previous_row:
            continue

        row["hidden"] = bool(previous_row.get("hidden"))

        if box_id not in product_details:
            continue

        detail = product_details[box_id]
        if should_refresh_imported_title(
            detail.get("title", ""),
            previous_row.get("itemName", ""),
            row.get("itemName", ""),
        ):
            product_details[box_id] = {**detail, "title": row.get("itemName", "")}

    return {
        "rows": imported_rows,
        "productDetails": product_details,
    }


def import_csv(csv_text: str, source_name: str, dry_run: bool = False) -> dict:
    imported_rows = rows_from_csv(csv_text)
    current_state = server.load_state()
    merged = merge_imported_rows(imported_rows, current_state)
    next_meta = {
        **current_state.get("meta", {}),
        "lastImportAt": server.dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "lastImportName": source_name,
        "lastImportSource": "automated-google-sheet",
    }
    next_state = {
        "rows": merged["rows"],
        "productDetails": merged["productDetails"],
        "meta": next_meta,
    }

    if not dry_run:
        server.save_state(next_state, "csv-import")

    return {
        "rowCount": len(imported_rows),
        "sourceName": source_name,
        "dryRun": dry_run,
    }


def main() -> int:
    load_env_file(APP_DIR / ".env")
    parser = argparse.ArgumentParser(description="Import Seller Dashboard data from a Google Sheet CSV URL.")
    parser.add_argument("--url", default=os.environ.get("SELLER_GOOGLE_SHEET_CSV_URL", ""))
    parser.add_argument("--source-name", default=os.environ.get("SELLER_GOOGLE_SHEET_NAME", "Google Sheet CSV"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.url:
        print("SELLER_GOOGLE_SHEET_CSV_URL is not set.", file=sys.stderr)
        return 2

    csv_text = fetch_csv(args.url)
    result = import_csv(csv_text, args.source_name, args.dry_run)
    action = "Checked" if args.dry_run else "Imported"
    print(f"{action} {result['rowCount']} row(s) from {result['sourceName']}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

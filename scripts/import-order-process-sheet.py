#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
from collections import Counter
from io import StringIO
from pathlib import Path
from urllib.request import Request, urlopen


APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

import server  # noqa: E402


DEFAULT_SHEET_URL = (
    "https://docs.google.com/spreadsheets/d/"
    "1nh4HWr8DAP26KziNTMGEtqs6LEkV8-Va9IDo7oTACQw/export?format=csv"
)

FIELD_ORDER = [
    "archived",
    "listed",
    "seller",
    "account",
    "productName",
    "specialDoubleCheck",
    "orderNumber",
    "orderDate",
    "tracking",
    "reviewPolicy",
    "reviewSubmitted",
    "reviewApproved",
    "itemPrice",
    "paidAmount",
    "payMethod",
    "paymentDay",
    "reviewNotes",
]

BOOLEAN_FIELDS = {"archived", "listed", "specialDoubleCheck"}
TEXT_FIELDS = [field for field in FIELD_ORDER if field not in BOOLEAN_FIELDS]

HEADER_TO_FIELD = {
    "archive": "archived",
    "archived": "archived",
    "listed": "listed",
    "seller": "seller",
    "account": "account",
    "product name": "productName",
    "special double check": "specialDoubleCheck",
    "order num": "orderNumber",
    "order number": "orderNumber",
    "order date": "orderDate",
    "tracking": "tracking",
    "rv policy": "reviewPolicy",
    "review policy": "reviewPolicy",
    "rv submitted": "reviewSubmitted",
    "review submitted": "reviewSubmitted",
    "rv apprvd, day": "reviewApproved",
    "rv approved, day": "reviewApproved",
    "review approved": "reviewApproved",
    "price items": "itemPrice",
    "price item": "itemPrice",
    "paid": "paidAmount",
    "pay method": "payMethod",
    "payment day": "paymentDay",
    "review\\notes": "reviewNotes",
    "review/notes": "reviewNotes",
    "review notes": "reviewNotes",
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
    request = Request(url, headers={"User-Agent": "seller-dashboard-process-import/1.0"})
    with urlopen(request, timeout=60) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def normalize_header(value: str) -> str:
    normalized = str(value or "").strip().lower()
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.rstrip(":").strip()


def header_to_field(value: str, index: int) -> str:
    normalized = normalize_header(value)
    if not normalized and index == 0:
        return "archived"
    return HEADER_TO_FIELD.get(normalized, "")


def parse_boolean(value: str) -> bool:
    return str(value or "").strip().lower() in {"true", "yes", "1", "x", "checked"}


def is_meaningful_row(row: dict) -> bool:
    if any(bool(row.get(field)) for field in BOOLEAN_FIELDS):
        return True
    return any(str(row.get(field) or "").strip() for field in TEXT_FIELDS)


def make_row_id(row: dict, occurrence: int) -> str:
    identity = {
        "orderNumber": row.get("orderNumber", ""),
        "orderDate": row.get("orderDate", ""),
        "seller": row.get("seller", ""),
        "account": row.get("account", ""),
        "productName": row.get("productName", ""),
        "occurrence": occurrence,
    }
    digest = hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"process-{digest[:16]}"


def rows_from_csv(text: str) -> list[dict]:
    parsed = [
        [cell.strip() for cell in row]
        for row in csv.reader(StringIO(text))
        if any(cell.strip() for cell in row)
    ]
    if not parsed:
        return []

    field_by_index = [header_to_field(cell, index) for index, cell in enumerate(parsed[0])]
    if "orderDate" not in field_by_index or "productName" not in field_by_index:
        raise ValueError("The order process sheet headers were not recognized.")

    rows: list[dict] = []
    identity_counts: Counter[str] = Counter()
    for sheet_row, cells in enumerate(parsed[1:], start=2):
        row = {field: False if field in BOOLEAN_FIELDS else "" for field in FIELD_ORDER}
        for index, raw in enumerate(cells):
            field = field_by_index[index] if index < len(field_by_index) else ""
            if not field:
                continue
            row[field] = parse_boolean(raw) if field in BOOLEAN_FIELDS else raw

        if not is_meaningful_row(row):
            continue

        identity_key = json.dumps(
            {
                "orderNumber": row.get("orderNumber", ""),
                "orderDate": row.get("orderDate", ""),
                "seller": row.get("seller", ""),
                "account": row.get("account", ""),
                "productName": row.get("productName", ""),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        identity_counts[identity_key] += 1
        row["id"] = make_row_id(row, identity_counts[identity_key])
        row["sheetRow"] = sheet_row
        rows.append(row)

    return rows


def import_csv(csv_text: str, source_name: str, source_url: str, dry_run: bool = False) -> dict:
    imported_rows = rows_from_csv(csv_text)
    current_state = server.load_order_process_state()
    next_meta = {
        **current_state.get("meta", {}),
        "lastImportAt": server.dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "lastImportName": source_name,
        "lastImportSource": "automated-google-sheet",
        "sourceUrl": source_url,
        "returnWindowDays": 30,
    }
    next_state = {
        "rows": imported_rows,
        "meta": next_meta,
    }

    if not dry_run:
        server.save_order_process_state(next_state, "sheet-import")

    return {
        "rowCount": len(imported_rows),
        "sourceName": source_name,
        "dryRun": dry_run,
    }


def main() -> int:
    load_env_file(APP_DIR / ".env")
    parser = argparse.ArgumentParser(
        description="Import the order review process data from a Google Sheet CSV URL."
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("SELLER_ORDER_PROCESS_SHEET_CSV_URL") or DEFAULT_SHEET_URL,
    )
    parser.add_argument(
        "--source-name",
        default=os.environ.get("SELLER_ORDER_PROCESS_SHEET_NAME") or "Order review process",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    csv_text = fetch_csv(args.url)
    result = import_csv(csv_text, args.source_name, args.url, args.dry_run)
    action = "Checked" if args.dry_run else "Imported"
    print(f"{action} {result['rowCount']} row(s) from {result['sourceName']}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

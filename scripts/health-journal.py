#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

from server import collect_and_journal_health, summarize_health_journal, read_health_journal  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Record or summarize Seller Dashboard health journal entries.")
    parser.add_argument("--source", default="timer", help="Source label stored in the journal entry.")
    parser.add_argument("--summary", action="store_true", help="Print today's journal summary after recording.")
    args = parser.parse_args()

    payload, entry = collect_and_journal_health(args.source)
    if args.summary:
        entries = read_health_journal(entry["date"])
        print(json.dumps(summarize_health_journal(entries, entry["date"]), indent=2, sort_keys=True))
    else:
        print(
            json.dumps(
                {
                    "recordedAt": entry["recordedAt"],
                    "date": entry["date"],
                    "status": payload.get("status"),
                    "counts": payload.get("counts"),
                    "problems": len(entry.get("problemItems", [])),
                },
                sort_keys=True,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

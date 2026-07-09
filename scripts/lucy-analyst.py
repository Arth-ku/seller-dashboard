#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

from server import (  # noqa: E402
    LUCY_TRACKED_INSIGHTS_PATH,
    journal_date_from_timestamp,
    load_state,
    read_health_journal,
    save_lucy_insights,
    summarize_health_journal,
)


STALE_LISTING_DAYS = 150
CATEGORY_RANGES = {
    "Units": [(1, 699), (800, 999)],
    "HVAC": [(700, 800)],
    "Apparel": [(1000, 1100)],
}


def local_now() -> dt.datetime:
    return dt.datetime.now().astimezone()


def parse_currency(value: object) -> float:
    cleaned = re.sub(r"[^0-9.\-]", "", str(value or ""))
    if cleaned in {"", "-", ".", "-."}:
        return 0.0
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def parse_expense(value: object) -> float:
    return abs(parse_currency(value))


def parse_loose_date(value: object, now: dt.datetime | None = None) -> dt.datetime | None:
    now = now or local_now()
    match = re.search(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b", str(value or ""))
    if not match:
        return None
    month = int(match.group(1))
    day = int(match.group(2))
    year = int(match.group(3)) if match.group(3) else now.year
    if year < 100:
        year += 2000
    try:
        return dt.datetime(year, month, day, tzinfo=now.tzinfo)
    except ValueError:
        return None


def dates_from_text(value: object, now: dt.datetime | None = None) -> list[dt.datetime]:
    now = now or local_now()
    dates = []
    for match in re.finditer(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b", str(value or "")):
        parsed = parse_loose_date(match.group(0), now)
        if parsed:
            dates.append(parsed)
    return dates


def days_between(left: dt.datetime, right: dt.datetime) -> int:
    return max(0, (right.date() - left.date()).days)


def listing_dates(row: dict, now: dt.datetime) -> list[dt.datetime]:
    return [
        parsed
        for parsed in (
            parse_loose_date(row.get("facebook"), now),
            parse_loose_date(row.get("craiglist"), now),
            parse_loose_date(row.get("ebay"), now),
            parse_loose_date(row.get("mercari"), now),
        )
        if parsed
    ]


def first_listed_date(row: dict, now: dt.datetime) -> dt.datetime | None:
    dates = listing_dates(row, now)
    return min(dates) if dates else None


def latest_action_date(row: dict, now: dt.datetime) -> dt.datetime | None:
    candidates = listing_dates(row, now)
    candidates.append(parse_loose_date(row.get("priceChangedDate"), now))
    candidates.extend(dates_from_text(" ".join([str(row.get("boost") or ""), str(row.get("boost2") or ""), str(row.get("notes") or "")]), now))
    candidates = [item for item in candidates if item]
    return max(candidates) if candidates else None


def active_price(row: dict) -> float:
    revised = parse_currency(row.get("revised"))
    return revised if revised > 0 else parse_currency(row.get("priceListed"))


def has_boost_notes(row: dict) -> bool:
    return bool(str(row.get("boost") or "").strip() or str(row.get("boost2") or "").strip())


def strip_box_id_prefix(title: object, box_id: object) -> str:
    text = str(title or "").strip()
    box = str(box_id or "").strip()
    if not text or not box:
        return text
    return re.sub(rf"^{re.escape(box)}(?:\b|\s*[-:)#.(]\s*)", "", text, flags=re.I).strip()


def item_title(row: dict, details: dict) -> str:
    detail = details.get(str(row.get("boxId") or ""), {}) if isinstance(details, dict) else {}
    title = detail.get("title") or row.get("itemName") or ""
    return strip_box_id_prefix(title, row.get("boxId")) or "Untitled item"


def row_has_images(row: dict, details: dict) -> bool:
    detail = details.get(str(row.get("boxId") or ""), {}) if isinstance(details, dict) else {}
    return bool(isinstance(detail.get("images"), list) and detail.get("images"))


def row_has_listing_content(row: dict, details: dict) -> bool:
    detail = details.get(str(row.get("boxId") or ""), {}) if isinstance(details, dict) else {}
    return bool(str(detail.get("title") or "").strip() or str(detail.get("description") or "").strip())


def build_live_advice(age_days: int | None, boosted: bool, has_price: bool, has_images: bool, has_content: bool, row: dict) -> str:
    if not has_price:
        return "Set a real price before spending time on promotion."
    if not has_images:
        return "Add photos first; ads without photos waste attention."
    if not has_content:
        return "Improve title/description before boosting."
    if age_days is None:
        return "Add a platform listing date so listing age can be measured."
    if age_days >= 180 and boosted:
        return "Stop repeating the same ad; change price, photos, title, or channel."
    if age_days >= STALE_LISTING_DAYS and not boosted:
        return "Refresh listing and test a small boost after improving title/photos."
    if age_days >= 90 and parse_currency(row.get("revised")) <= 0:
        return "Consider a revised price or bundle offer."
    return "Monitor. No urgent action from current signals."


def build_quick_win(age_days: int | None, idle_days: int | None, boosted: bool, has_price: bool, has_images: bool, has_content: bool, row: dict) -> str:
    if has_price and not has_images:
        return "Add photos; this is the fastest listing-quality improvement."
    if has_images and not has_content:
        return "Write a stronger title/description before paying for ads."
    if age_days is not None and age_days >= STALE_LISTING_DAYS and not boosted:
        return "Refresh listing, then try a small 3-day boost."
    if idle_days is not None and idle_days >= 45:
        return "Update listing content or relist; no recent action is recorded."
    if age_days is not None and age_days >= 120 and parse_currency(row.get("revised")) <= 0:
        return "Test a revised price before another ad spend."
    if boosted and age_days is not None and age_days >= 120:
        return "Promotion alone is not solving it; change creative or channel."
    return ""


def score_live_item(row: dict, details: dict, now: dt.datetime) -> dict:
    listed_date = first_listed_date(row, now)
    latest_date = latest_action_date(row, now)
    age_days = days_between(listed_date, now) if listed_date else None
    idle_days = days_between(latest_date, now) if latest_date else age_days
    has_price = active_price(row) > 0
    boosted = has_boost_notes(row)
    has_images = row_has_images(row, details)
    has_content = row_has_listing_content(row, details)
    reasons = []
    score = 0

    if age_days is None:
        score += 28
        reasons.append("No listing date")
    elif age_days >= 180:
        score += 34
        reasons.append(f"{age_days} days listed")
    elif age_days >= STALE_LISTING_DAYS:
        score += 25
        reasons.append(f"{age_days} days listed")
    elif age_days >= 90:
        score += 12
        reasons.append(f"{age_days} days listed")

    if idle_days is not None and idle_days >= 45:
        score += 10
        reasons.append(f"{idle_days} days no action")
    if not has_price:
        score += 24
        reasons.append("No usable price")
    if not boosted and age_days is not None and age_days >= 60:
        score += 16
        reasons.append("No boost note")
    if boosted and age_days is not None and age_days >= 120:
        score += 12
        reasons.append("Boosted but still unsold")
    if not has_images:
        score += 18
        reasons.append("No photos")
    if not has_content:
        score += 10
        reasons.append("Missing title/description")
    if parse_currency(row.get("revised")) > 0 and parse_currency(row.get("revised")) < parse_currency(row.get("priceListed")):
        score += 8 if age_days is not None and age_days >= 120 else 2
        reasons.append("Already discounted")

    quick_win = build_quick_win(age_days, idle_days, boosted, has_price, has_images, has_content, row)
    return {
        "boxId": str(row.get("boxId") or ""),
        "title": item_title(row, details),
        "score": score,
        "severity": "bad" if score >= 55 else "watch" if score >= 30 else "ok",
        "ageDays": age_days,
        "idleDays": idle_days,
        "price": active_price(row),
        "reasons": reasons or ["Looks healthy"],
        "primaryAdvice": build_live_advice(age_days, boosted, has_price, has_images, has_content, row),
        "quickWin": quick_win,
        "quickWinScore": (30 if quick_win else 0) + score,
    }


def category_for_row(row: dict) -> str:
    raw = str(row.get("boxId") or "").strip()
    if not raw.isdigit():
        return "Units"
    number = int(raw)
    for label, ranges in CATEGORY_RANGES.items():
        if any(start <= number <= end for start, end in ranges):
            return label
    return "Uncategorized"


def health_summary() -> dict:
    date_text = journal_date_from_timestamp()
    entries = read_health_journal(date_text)
    if not entries:
        return {"date": date_text, "status": "unknown", "message": "no journal entries yet", "problems": [], "snapshotCount": 0}
    return summarize_health_journal(entries, date_text)


def normalize_channel(value: object) -> str:
    text = str(value or "").strip().lower().rstrip(",")
    aliases = {
        "fb": "Facebook",
        "facebook": "Facebook",
        "facebook marketplace": "Facebook",
        "craiglist": "Craigslist",
        "craigslist": "Craigslist",
        "ebay": "eBay",
        "mercari": "Mercari",
    }
    return aliases.get(text, text.title() if text else "")


def build_sales_lessons(sold_rows: list[dict]) -> list[dict]:
    channels: dict[str, dict] = {}
    cleanup = {"missingFinalPrice": 0, "missingSoldThrough": 0, "missingSoldDay": 0}
    for row in sold_rows:
        final_price = parse_currency(row.get("finalPrice"))
        if final_price <= 0:
            cleanup["missingFinalPrice"] += 1
        if not str(row.get("soldThrough") or "").strip():
            cleanup["missingSoldThrough"] += 1
        if not str(row.get("soldDay") or "").strip():
            cleanup["missingSoldDay"] += 1
        channel = normalize_channel(row.get("soldThrough"))
        if channel:
            stats = channels.setdefault(channel, {"channel": channel, "count": 0, "revenue": 0.0})
            stats["count"] += 1
            stats["revenue"] += max(0.0, final_price)

    best_channels = sorted(channels.values(), key=lambda item: (-item["count"], -item["revenue"]))[:3]
    return [
        {
            "label": item["channel"],
            "value": f"{item['count']} sold / ${item['revenue']:.0f}",
            "detail": "Use this when deciding where to refresh similar live inventory.",
            "severity": "ok",
        }
        for item in best_channels
    ] + [
        {
            "label": "Sales cleanup",
            "value": f"{sum(cleanup.values())} missing sold fields",
            "detail": ", ".join(f"{key}: {value}" for key, value in cleanup.items() if value) or "Archived sales fields look usable.",
            "severity": "watch" if sum(cleanup.values()) else "ok",
        }
    ]


def build_insights() -> dict:
    now = local_now()
    state = load_state()
    rows = [row for row in state.get("rows", []) if isinstance(row, dict)]
    details = state.get("productDetails", {}) if isinstance(state.get("productDetails"), dict) else {}
    live_rows = [row for row in rows if not row.get("archived")]
    sold_rows = [row for row in rows if row.get("archived")]
    live_scores = sorted((score_live_item(row, details, now) for row in live_rows), key=lambda item: (-item["score"], item["boxId"]))
    quick_wins = sorted((item for item in live_scores if item.get("quickWin")), key=lambda item: (-item["quickWinScore"], item["boxId"]))
    health = health_summary()
    health_problems = health.get("problems") if isinstance(health.get("problems"), list) else []
    bad_count = sum(1 for item in live_scores if item["severity"] == "bad")
    watch_count = sum(1 for item in live_scores if item["severity"] == "watch")
    status = (
        "bad"
        if health.get("status") == "bad" or bad_count
        else "watch"
        if health.get("status") != "ok" or health_problems or watch_count or not rows
        else "ok"
    )

    category_counts = {}
    for row in live_rows:
        category = category_for_row(row)
        category_counts[category] = category_counts.get(category, 0) + 1

    top_issue = live_scores[0] if live_scores else None
    headline = "Lucy sees no urgent unit or dashboard issue."
    if not rows:
        headline = "Lucy is waiting for production dashboard data."
    elif top_issue and top_issue["severity"] == "bad":
        headline = f"Lucy would work box {top_issue['boxId']} first."
    elif health_problems:
        headline = "Lucy found dashboard health items worth checking."
    elif quick_wins:
        headline = f"Lucy found {len(quick_wins)} quick inventory improvement ideas."

    actions = []
    for item in live_scores[:5]:
        if item["severity"] == "ok" and len(actions) >= 3:
            continue
        actions.append(
            {
                "title": f"Box {item['boxId']}: {item['title']}",
                "reason": item["primaryAdvice"],
                "evidence": "; ".join(item["reasons"]),
                "severity": "high" if item["severity"] == "bad" else "watch" if item["severity"] == "watch" else "low",
            }
        )

    unit_health_items = [
        {
            "label": f"Box {item['boxId']}",
            "value": item["primaryAdvice"],
            "detail": f"{item['title']} | score {item['score']} | {', '.join(item['reasons'])}",
            "severity": item["severity"],
        }
        for item in live_scores[:8]
    ]
    if not unit_health_items:
        unit_health_items = [
            {
                "label": "No live inventory loaded",
                "value": "Lucy needs the live SQLite state on the Pi to rank units.",
                "detail": "This is normal on a fresh local checkout before the production data folder is present.",
                "severity": "watch",
            }
        ]

    quick_win_items = [
        {
            "label": f"Box {item['boxId']}",
            "value": item["quickWin"],
            "detail": item["title"],
            "severity": "watch",
        }
        for item in quick_wins[:6]
    ]
    if not quick_win_items:
        quick_win_items = [
            {
                "label": "No quick wins yet",
                "value": "Lucy did not find a listing/photo/price action from the currently loaded data.",
                "detail": "On production this will update after the Google Sheet import and health journal are present.",
                "severity": "ok" if rows else "watch",
            }
        ]

    sections = [
        {
            "title": "Unit-health priorities",
            "summary": "Top live inventory ranked by listing age, missing price/photos/content, boost signals, and idle time.",
            "items": unit_health_items,
        },
        {
            "title": "Quick wins",
            "summary": "Small actions likely to improve listing quality or attention before spending more ad money.",
            "items": quick_win_items,
        },
        {
            "title": "Dashboard health",
            "summary": health.get("message", "Health journal summary unavailable."),
            "items": [
                {
                    "label": problem.get("label", "Health problem"),
                    "value": f"{problem.get('latestState', 'warn')} - {problem.get('latestValue', '')}",
                    "detail": problem.get("latestDetail", ""),
                    "severity": "bad" if problem.get("latestState") == "bad" else "watch",
                }
                for problem in health_problems[:8]
            ]
            or [
                {
                    "label": "Health journal",
                    "value": "No health journal entries yet." if health.get("status") == "unknown" else "No dashboard health problems in today's journal.",
                    "detail": f"{health.get('snapshotCount', 0)} snapshots reviewed.",
                    "severity": "watch" if health.get("status") == "unknown" else "ok",
                }
            ],
        },
        {
            "title": "Sales lessons",
            "summary": "Archived rows are used as the learning set for channels, revenue, and cleanup gaps.",
            "items": build_sales_lessons(sold_rows),
        },
    ]

    cards = [
        {"label": "Live items", "value": str(len(live_rows)), "detail": f"{bad_count} critical, {watch_count} watch", "severity": "bad" if bad_count else "watch" if watch_count or not rows else "ok"},
        {"label": "Top unit score", "value": str(top_issue["score"]) if top_issue else "0", "detail": f"Box {top_issue['boxId']}" if top_issue else "No live inventory", "severity": top_issue["severity"] if top_issue else "watch" if not rows else "ok"},
        {"label": "Quick wins", "value": str(len(quick_wins)), "detail": "Listing/photo/price moves Lucy can see now", "severity": "watch" if quick_wins or not rows else "ok"},
        {"label": "Dashboard health", "value": str(health.get("status", "unknown")).upper(), "detail": f"{health.get('snapshotCount', 0)} snapshots today", "severity": "bad" if health.get("status") == "bad" else "watch" if health.get("status") != "ok" or health_problems else "ok"},
    ]

    category_summary = ", ".join(f"{name}: {count}" for name, count in sorted(category_counts.items()))
    summary_parts = [
        f"{len(live_rows)} live items" + (f" across {category_summary}" if category_summary else ""),
        f"{len(quick_wins)} quick wins",
        f"dashboard health: {health.get('message', health.get('status', 'unknown'))}",
    ]

    return {
        "schemaVersion": 1,
        "generatedAt": now.isoformat(timespec="seconds"),
        "status": status,
        "headline": headline,
        "summary": ". ".join(part for part in summary_parts if part) + ".",
        "cards": cards,
        "actions": actions,
        "sections": sections,
        "source": {
            "kind": "lucy-analyst",
            "rowCount": len(rows),
            "liveCount": len(live_rows),
            "soldCount": len(sold_rows),
            "healthDate": health.get("date", journal_date_from_timestamp()),
        },
    }


def run_git(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, cwd=str(APP_DIR), capture_output=True, text=True, check=False)


def git_has_lucy_changes() -> bool:
    result = run_git(["git", "status", "--porcelain", "--", str(LUCY_TRACKED_INSIGHTS_PATH.relative_to(APP_DIR))])
    return bool(result.stdout.strip())


def commit_lucy_changes(push: bool) -> dict:
    relative_path = str(LUCY_TRACKED_INSIGHTS_PATH.relative_to(APP_DIR))
    if not git_has_lucy_changes():
        return {"committed": False, "pushed": False, "reason": "no insight change"}

    add_result = run_git(["git", "add", "--", relative_path])
    if add_result.returncode != 0:
        return {"committed": False, "pushed": False, "error": add_result.stderr.strip() or add_result.stdout.strip()}

    stamp = local_now().strftime("%Y-%m-%d %H:%M")
    commit_result = run_git(["git", "commit", "-m", f"Lucy insight update {stamp}"])
    if commit_result.returncode != 0:
        return {"committed": False, "pushed": False, "error": commit_result.stderr.strip() or commit_result.stdout.strip()}

    output = {"committed": True, "pushed": False, "commit": commit_result.stdout.strip()}
    if push:
        push_result = run_git(["git", "push"])
        output["pushed"] = push_result.returncode == 0
        if push_result.returncode != 0:
            output["pushError"] = push_result.stderr.strip() or push_result.stdout.strip()
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate Lucy's seller-dashboard analyst insight page.")
    parser.add_argument("--write", action="store_true", help="Publish the generated insight to Lucy storage.")
    parser.add_argument("--commit", action="store_true", help="Commit lucy/insights.json if it changed.")
    parser.add_argument("--push", action="store_true", help="Push after committing.")
    args = parser.parse_args()

    insights = build_insights()
    if args.write:
        insights = save_lucy_insights(insights, "lucy-analyst")

    git_result = None
    if args.commit:
        git_result = commit_lucy_changes(args.push)

    if git_result is not None:
        insights["git"] = git_result
    print(json.dumps(insights, indent=2, sort_keys=True))
    return 1 if git_result and git_result.get("error") else 0


if __name__ == "__main__":
    raise SystemExit(main())

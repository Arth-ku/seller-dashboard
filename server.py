from __future__ import annotations

import json
import mimetypes
import os
import datetime as dt
import shutil
import sqlite3
import subprocess
import time
import uuid
from email.parser import BytesParser
from email.policy import default
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
UPLOADS_DIR = ROOT / "uploads"
DB_PATH = DATA_DIR / "seller_dashboard.db"
HEALTH_JOURNAL_DIR = DATA_DIR / "health-journal"
HOST = os.environ.get("SELLER_DASHBOARD_HOST", "0.0.0.0")
PORT = int(os.environ.get("SELLER_DASHBOARD_PORT", "8000"))
BASE_PATH = os.environ.get("SELLER_DASHBOARD_BASE_PATH", "").strip()
PUBLIC_ALLOWED_ORIGIN = os.environ.get("SELLER_PUBLIC_ALLOWED_ORIGIN", "*").strip() or "*"
JSON_HEADERS = {"Content-Type": "application/json; charset=utf-8"}
HEALTH_LIGHT_CACHE_SECONDS = 10
HEALTH_DEEP_CACHE_SECONDS = 300
APPAREL_MIN_BOX_ID = 1000
APPAREL_MAX_BOX_ID = 1100
APPAREL_BRANDS = (
    "Christian Louboutin",
    "Balenciaga",
    "Louis Vuitton",
    "Gucci",
    "Prada",
    "Chanel",
    "Dior",
    "Fendi",
    "Versace",
    "Burberry",
    "Saint Laurent",
    "Yves Saint Laurent",
    "Valentino",
    "Givenchy",
    "Alexander McQueen",
    "Dolce & Gabbana",
    "Moncler",
    "Canada Goose",
    "Nike",
    "Adidas",
)
HVAC_MIN_BOX_ID = 700
HVAC_MAX_BOX_ID = 800
HVAC_BRANDS = (
    "Carrier",
    "Trane",
    "Lennox",
    "Goodman",
    "Rheem",
    "Ruud",
    "York",
    "Mitsubishi",
    "Daikin",
    "Fujitsu",
    "LG",
    "Samsung",
    "Frigidaire",
    "Midea",
    "Hisense",
    "Toshiba",
    "Honeywell",
    "Whynter",
    "DeLonghi",
    "BLACK+DECKER",
)
CATALOGS = {
    "apparel": {
        "from": APPAREL_MIN_BOX_ID,
        "to": APPAREL_MAX_BOX_ID,
        "clients": APPAREL_BRANDS,
    },
    "hvac": {
        "from": HVAC_MIN_BOX_ID,
        "to": HVAC_MAX_BOX_ID,
        "clients": HVAC_BRANDS,
    },
}
HEALTH_CACHE = {
    "light": {"expires_at": 0.0, "value": None},
    "deep": {"expires_at": 0.0, "value": None},
}


def normalize_base_path(value: str) -> str:
    trimmed = value.strip()
    if not trimmed or trimmed == "/":
        return ""
    return f"/{trimmed.strip('/')}"


APP_PREFIX = normalize_base_path(BASE_PATH)

mimetypes.add_type("image/heic", ".heic")
mimetypes.add_type("image/heif", ".heif")


def ensure_app_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        for key, value in (
            ("rows", "[]"),
            ("productDetails", "{}"),
            ("meta", "{}"),
        ):
            connection.execute(
                "INSERT OR IGNORE INTO app_state (key, value) VALUES (?, ?)",
                (key, value),
            )
        connection.commit()


def load_state() -> dict:
    ensure_app_storage()

    with sqlite3.connect(DB_PATH) as connection:
        rows = {}
        for key, value in connection.execute("SELECT key, value FROM app_state"):
            rows[key] = json.loads(value)

    return {
        "rows": rows.get("rows", []),
        "productDetails": rows.get("productDetails", {}),
        "meta": rows.get("meta", {}),
    }


def bytes_human(value: int) -> str:
    amount = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if amount < 1024 or unit == "TB":
            return f"{amount:.1f} {unit}" if unit != "B" else f"{int(amount)} B"
        amount /= 1024
    return f"{value} B"


def run_command(command: list[str], timeout: int = 3) -> tuple[int, str]:
    try:
        result = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return 127, str(exc)
    return result.returncode, result.stdout.strip()


def directory_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for root, _, files in os.walk(path):
        for filename in files:
            try:
                total += (Path(root) / filename).stat().st_size
            except OSError:
                continue
    return total


def status_item(state: str, label: str, value: str, detail: str = "") -> dict:
    return {"state": state, "label": label, "value": value, "detail": detail}


def disk_health(path: Path, label: str) -> dict:
    usage = shutil.disk_usage(path)
    free_percent = usage.free / usage.total * 100
    if free_percent < 10:
        state = "bad"
    elif free_percent < 20:
        state = "warn"
    else:
        state = "ok"
    return status_item(
        state,
        label,
        f"{bytes_human(usage.free)} free",
        f"{bytes_human(usage.total)} total, {free_percent:.0f}% free",
    )


def service_health(name: str) -> dict:
    active_code, active = run_command(["systemctl", "is-active", name])
    enabled_code, enabled = run_command(["systemctl", "is-enabled", name])
    active_text = active or "unknown"
    enabled_text = enabled or "unknown"
    if active_code == 0 and enabled_code == 0:
        state = "ok"
    elif active_text == "active":
        state = "warn"
    else:
        state = "bad"
    return status_item(state, name, active_text, enabled_text)


def endpoint_health(label: str, url: str, headers: dict[str, str] | None = None) -> dict:
    request = Request(url, headers={"Accept": "application/json,text/html,*/*", **(headers or {})})
    started_at = time.monotonic()
    try:
        with urlopen(request, timeout=4) as response:
            response.read(256)
            elapsed_ms = int((time.monotonic() - started_at) * 1000)
            status = response.getcode()
    except Exception as exc:
        return status_item("bad", label, "Unavailable", str(exc))

    state = "ok" if 200 <= status < 300 else "warn"
    return status_item(state, label, f"HTTP {status}", f"{elapsed_ms} ms")


def cpu_temp_health() -> dict:
    try:
        celsius = int(Path("/sys/class/thermal/thermal_zone0/temp").read_text().strip()) / 1000
    except Exception as exc:
        return status_item("warn", "CPU temperature", "Unavailable", str(exc))
    if celsius >= 80:
        state = "bad"
    elif celsius >= 70:
        state = "warn"
    else:
        state = "ok"
    return status_item(state, "CPU temperature", f"{celsius:.1f} C")


def gpu_health() -> dict:
    temp_code, temp = run_command(["vcgencmd", "measure_temp"])
    throttle_code, throttle = run_command(["vcgencmd", "get_throttled"])
    parts = []
    state = "ok"

    if temp_code == 0 and temp:
        parts.append(temp.replace("temp=", "Temp "))
    else:
        parts.append("Temp unavailable")
        state = "warn"

    if throttle_code == 0 and throttle:
        parts.append(throttle)
        if not throttle.endswith("0x0"):
            state = "warn"
    else:
        parts.append("Throttle unavailable")
        state = "warn"

    return status_item(state, "GPU / throttle", parts[0], "; ".join(parts[1:]))


def memory_health() -> dict:
    meminfo = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, value = line.split(":", 1)
            meminfo[key] = int(value.strip().split()[0]) * 1024
    except Exception as exc:
        return status_item("warn", "Memory", "Unavailable", str(exc))

    total = meminfo.get("MemTotal", 0)
    available = meminfo.get("MemAvailable", 0)
    free_percent = available / total * 100 if total else 0
    state = "bad" if free_percent < 8 else "warn" if free_percent < 15 else "ok"
    return status_item(state, "Memory", bytes_human(available), f"{bytes_human(total)} total")


def backup_health() -> dict:
    backup_dir = DATA_DIR / "backups"
    backups = sorted(backup_dir.glob("seller_dashboard-*.db"), key=lambda item: item.stat().st_mtime)
    if not backups:
        return status_item("bad", "Database backups", "None found", str(backup_dir))
    latest = backups[-1]
    age_minutes = max(0, int((time.time() - latest.stat().st_mtime) // 60))
    state = "ok" if age_minutes <= 90 else "warn"
    return status_item(
        state,
        "Database backups",
        f"{age_minutes} min old",
        f"{bytes_human(latest.stat().st_size)}, {len(backups)} retained",
    )


def database_health() -> dict:
    if not DB_PATH.exists():
        return status_item("bad", "Database", "Missing", str(DB_PATH))
    try:
        with sqlite3.connect(DB_PATH) as connection:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            row_count = connection.execute("SELECT length(value) FROM app_state WHERE key = 'rows'").fetchone()
    except sqlite3.Error as exc:
        return status_item("bad", "Database", "Error", str(exc))
    state = "ok" if integrity == "ok" else "bad"
    return status_item(state, "Database", f"Integrity {integrity}", f"rows JSON bytes: {row_count[0] if row_count else 0}")


def get_cached_health(key: str, ttl_seconds: int, collector) -> dict:
    now = time.monotonic()
    cached = HEALTH_CACHE[key]
    if cached["value"] is not None and cached["expires_at"] > now:
        return cached["value"]
    value = collector()
    cached["value"] = value
    cached["expires_at"] = now + ttl_seconds
    return value


def collect_light_health() -> dict:
    return {
        "items": [
            disk_health(ROOT, "Site storage"),
            status_item(
                "ok" if UPLOADS_DIR.exists() else "bad",
                "Uploads folder",
                "Present" if UPLOADS_DIR.exists() else "Missing",
                str(UPLOADS_DIR),
            ),
            status_item(
                "ok" if Path("/var/www/authenticitycheck").exists() else "bad",
                "Public static root",
                "Present" if Path("/var/www/authenticitycheck").exists() else "Missing",
                "/var/www/authenticitycheck",
            ),
            cpu_temp_health(),
            gpu_health(),
            memory_health(),
            service_health("seller-dashboard"),
            service_health("nginx"),
            service_health("cloudflared"),
            service_health("seller-dashboard-backup.timer"),
            endpoint_health("Private API", "http://127.0.0.1:8000/sell/api/ping"),
            endpoint_health("Public homepage", "http://127.0.0.1/", {"Host": "authenticitycheck.net"}),
            endpoint_health(
                "Public product API",
                "http://127.0.0.1/sell/api/public/products/620",
                {"Host": "authenticitycheck.net"},
            ),
        ],
        "collectedAt": int(time.time()),
    }


def collect_deep_health() -> dict:
    return {
        "items": [
            database_health(),
            backup_health(),
            status_item(
                "ok" if UPLOADS_DIR.exists() else "bad",
                "Uploads size",
                bytes_human(directory_size(UPLOADS_DIR)),
                "Scanned every 5 minutes",
            ),
        ],
        "collectedAt": int(time.time()),
    }


def collect_health_payload() -> dict:
    light = get_cached_health("light", HEALTH_LIGHT_CACHE_SECONDS, collect_light_health)
    deep = get_cached_health("deep", HEALTH_DEEP_CACHE_SECONDS, collect_deep_health)
    items = light["items"] + deep["items"]
    counts = {"ok": 0, "warn": 0, "bad": 0}
    for item in items:
        counts[item["state"]] = counts.get(item["state"], 0) + 1
    return {
        "status": "bad" if counts["bad"] else "warn" if counts["warn"] else "ok",
        "counts": counts,
        "items": items,
        "refreshSeconds": 15,
        "cache": {
            "lightSeconds": HEALTH_LIGHT_CACHE_SECONDS,
            "deepSeconds": HEALTH_DEEP_CACHE_SECONDS,
        },
        "collectedAt": max(light["collectedAt"], deep["collectedAt"]),
    }


def local_now() -> dt.datetime:
    return dt.datetime.now().astimezone()


def journal_date_from_timestamp(timestamp: int | float | None = None) -> str:
    moment = dt.datetime.fromtimestamp(timestamp, tz=local_now().tzinfo) if timestamp else local_now()
    return moment.date().isoformat()


def health_journal_path(date_text: str) -> Path:
    return HEALTH_JOURNAL_DIR / f"{date_text}.jsonl"


def health_journal_entry(payload: dict, source: str = "api") -> dict:
    recorded_at = local_now()
    problem_items = [
        {
            "state": item.get("state", "warn"),
            "label": item.get("label", "Unknown"),
            "value": item.get("value", ""),
            "detail": item.get("detail", ""),
        }
        for item in payload.get("items", [])
        if item.get("state") != "ok"
    ]
    return {
        "recordedAt": recorded_at.isoformat(timespec="seconds"),
        "date": recorded_at.date().isoformat(),
        "source": source,
        "status": payload.get("status", "warn"),
        "counts": payload.get("counts", {}),
        "collectedAt": payload.get("collectedAt"),
        "problemItems": problem_items,
    }


def append_health_journal(payload: dict, source: str = "api") -> dict:
    entry = health_journal_entry(payload, source)
    HEALTH_JOURNAL_DIR.mkdir(parents=True, exist_ok=True)
    with health_journal_path(entry["date"]).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, separators=(",", ":")) + "\n")
    return entry


def read_health_journal(date_text: str) -> list[dict]:
    path = health_journal_path(date_text)
    entries = []
    if not path.exists():
        return entries
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def summarize_health_journal(entries: list[dict], date_text: str) -> dict:
    snapshot_counts = {"ok": 0, "warn": 0, "bad": 0}
    max_item_counts = {"ok": 0, "warn": 0, "bad": 0}
    problem_summary: dict[str, dict] = {}

    for entry in entries:
        status = entry.get("status", "warn")
        snapshot_counts[status] = snapshot_counts.get(status, 0) + 1
        counts = entry.get("counts", {})
        for state in max_item_counts:
            max_item_counts[state] = max(max_item_counts[state], int(counts.get(state, 0) or 0))

        for item in entry.get("problemItems", []):
            label = item.get("label", "Unknown")
            summary = problem_summary.setdefault(
                label,
                {
                    "label": label,
                    "warnSnapshots": 0,
                    "badSnapshots": 0,
                    "latestState": "warn",
                    "latestValue": "",
                    "latestDetail": "",
                    "latestAt": "",
                },
            )
            state = item.get("state", "warn")
            if state == "bad":
                summary["badSnapshots"] += 1
            else:
                summary["warnSnapshots"] += 1
            summary["latestState"] = state
            summary["latestValue"] = item.get("value", "")
            summary["latestDetail"] = item.get("detail", "")
            summary["latestAt"] = entry.get("recordedAt", "")

    latest = entries[-1] if entries else None
    problems = sorted(
        problem_summary.values(),
        key=lambda item: (item["badSnapshots"], item["warnSnapshots"], item["label"]),
        reverse=True,
    )
    return {
        "date": date_text,
        "ok": bool(entries) and snapshot_counts.get("warn", 0) == 0 and snapshot_counts.get("bad", 0) == 0,
        "status": latest.get("status", "unknown") if latest else "unknown",
        "message": "all ok" if entries and not problems else "needs attention" if problems else "no journal entries yet",
        "snapshotCount": len(entries),
        "firstRecordedAt": entries[0].get("recordedAt") if entries else None,
        "lastRecordedAt": latest.get("recordedAt") if latest else None,
        "snapshotCounts": snapshot_counts,
        "latestCounts": latest.get("counts", {}) if latest else {"ok": 0, "warn": 0, "bad": 0},
        "maxItemCounts": max_item_counts,
        "problems": problems,
    }


def collect_and_journal_health(source: str = "api") -> tuple[dict, dict]:
    payload = collect_health_payload()
    entry = append_health_journal(payload, source)
    return payload, entry


def save_state(state: dict) -> None:
    ensure_app_storage()
    previous_state = load_state()
    next_rows = state.get("rows", [])
    next_details = state.get("productDetails", {})
    next_meta = state.get("meta", {})

    with sqlite3.connect(DB_PATH) as connection:
        connection.execute("UPDATE app_state SET value = ? WHERE key = 'rows'", (json.dumps(next_rows),))
        connection.execute(
            "UPDATE app_state SET value = ? WHERE key = 'productDetails'",
            (json.dumps(next_details),),
        )
        connection.execute("UPDATE app_state SET value = ? WHERE key = 'meta'", (json.dumps(next_meta),))
        connection.commit()

    cleanup_orphaned_uploads(previous_state.get("productDetails", {}), next_details)


def cleanup_orphaned_uploads(previous_details: dict, next_details: dict) -> None:
    previous_paths = extract_uploaded_paths(previous_details)
    next_paths = extract_uploaded_paths(next_details)

    for orphan_path in previous_paths - next_paths:
        delete_uploaded_file(orphan_path)


def extract_uploaded_paths(details_map: dict) -> set[str]:
    paths: set[str] = set()
    for detail in details_map.values():
        for image in detail.get("images", []):
            path = image.get("storagePath")
            if path:
                paths.add(path)
    return paths


def delete_uploaded_file(storage_path: str) -> None:
    if not storage_path:
        return

    candidate = (ROOT / storage_path).resolve()
    try:
        candidate.relative_to(UPLOADS_DIR.resolve())
    except ValueError:
        return

    if candidate.exists() and candidate.is_file():
        candidate.unlink()
        remove_empty_parent_dirs(candidate.parent)


def remove_empty_parent_dirs(directory: Path) -> None:
    uploads_root = UPLOADS_DIR.resolve()
    current = directory.resolve()

    while current != uploads_root and current.exists():
        if any(current.iterdir()):
            break
        current.rmdir()
        current = current.parent


def sanitize_box_id(box_id: str) -> str:
    cleaned = "".join(char if char.isalnum() or char == "-" else "-" for char in box_id.strip().upper())
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned or "UNKNOWN"


def sanitize_filename(name: str) -> str:
    safe = "".join(char if char.isalnum() or char in {".", "-", "_"} else "-" for char in name.strip())
    return safe or "image"


def strip_box_id_prefix(text: str, box_id: str) -> str:
    normalized_text = str(text or "").strip()
    normalized_box_id = str(box_id or "").strip()

    if not normalized_text or not normalized_box_id:
        return normalized_text

    prefix = normalized_box_id.upper()
    candidate = normalized_text.upper()
    if candidate == prefix:
        return ""

    if candidate.startswith(prefix):
        remainder = normalized_text[len(normalized_box_id) :].lstrip(" -:)#.(\t")
        return remainder.strip()

    return normalized_text


def public_product_payload(
    row: dict | None,
    detail: dict,
    box_id: str,
    request_handler,
    client_brands: tuple[str, ...] = APPAREL_BRANDS,
) -> dict:
    title = strip_box_id_prefix(detail.get("title", ""), box_id)
    item_name = strip_box_id_prefix((row or {}).get("itemName", ""), box_id)
    public_images = []
    for image in detail.get("images", []):
        image_url = image.get("url") or ""
        public_images.append(
            {
                "name": image.get("name", ""),
                "url": request_handler.absolute_url(image_url) if image_url.startswith("/") else image_url,
            }
        )

    searchable_text = " ".join(
        [
            title,
            item_name,
            detail.get("description", ""),
            (row or {}).get("notes", ""),
        ]
    )

    return {
        "boxId": box_id,
        "itemName": item_name,
        "title": title,
        "description": detail.get("description", ""),
        "price": (row or {}).get("revised") or (row or {}).get("priceListed") or "",
        "images": public_images,
        "client": detect_catalog_client(searchable_text, client_brands),
        "updatedAt": detail.get("updatedAt", ""),
    }


def detect_catalog_client(text: str, client_brands: tuple[str, ...]) -> str:
    normalized = str(text or "").lower()
    for brand in client_brands:
        if brand.lower() in normalized:
            return brand
    return ""


def has_public_catalog_content(product: dict) -> bool:
    return bool(
        str(product.get("title") or "").strip()
        or str(product.get("description") or "").strip()
        or product.get("images")
    )


class SellerDashboardHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        normalized_path = self._normalize_request_path(path)
        clean_path = normalized_path.lstrip("/")
        return str((ROOT / clean_path).resolve())

    def do_GET(self) -> None:
        normalized_path = self._normalize_request_path(self.path)

        if normalized_path is None:
            if APP_PREFIX and urlparse(self.path).path == "/":
                return self.redirect(f"{APP_PREFIX}/")
            return self.send_error(HTTPStatus.NOT_FOUND, "Not found")

        if normalized_path == "/api/state":
            return self.respond_json(load_state())

        if normalized_path == "/api/ping":
            return self.respond_json({"ok": True})

        if normalized_path == "/api/health":
            payload, entry = collect_and_journal_health("api")
            payload["journalEntry"] = {
                "recordedAt": entry["recordedAt"],
                "date": entry["date"],
            }
            return self.respond_json(payload)

        if normalized_path == "/api/health/journal/latest":
            return self.handle_health_journal_latest()

        if normalized_path in {"/api/health/journal", "/api/health/journal/today"}:
            return self.handle_health_journal_request()

        if normalized_path == "/health":
            return self.serve_health_page()

        if normalized_path == "/api/public/apparel":
            return self.handle_public_catalog_request("apparel")

        if normalized_path == "/api/public/hvac":
            return self.handle_public_catalog_request("hvac")

        if normalized_path.startswith("/api/public/products/"):
            return self.handle_public_product_request(normalized_path)

        if self._should_serve_index():
            return self.serve_index()

        resolved = Path(self.translate_path(self.path))
        if self._is_allowed_static(normalized_path, resolved):
            return super().do_GET()

        if Path(normalized_path).suffix:
            return self.send_error(HTTPStatus.NOT_FOUND, "File not found")

        return self.serve_index()

    def do_HEAD(self) -> None:
        normalized_path = self._normalize_request_path(self.path)
        if normalized_path is None:
            if APP_PREFIX and urlparse(self.path).path == "/":
                self.send_response(HTTPStatus.FOUND)
                self.send_header("Location", f"{APP_PREFIX}/")
                self.end_headers()
                return
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        if normalized_path == "/health":
            return self.serve_health_page(head_only=True)
        if self._should_serve_index():
            return self.serve_index(head_only=True)
        return super().do_HEAD()

    def do_PUT(self) -> None:
        normalized_path = self._normalize_request_path(self.path)
        if normalized_path != "/api/state":
            return self.respond_error(HTTPStatus.NOT_FOUND, "API route not found")

        payload = self.read_json_body()
        if payload is None:
            return

        save_state(
            {
                "rows": payload.get("rows", []),
                "productDetails": payload.get("productDetails", {}),
                "meta": payload.get("meta", {}),
            }
        )
        return self.respond_json({"ok": True})

    def do_POST(self) -> None:
        normalized_path = self._normalize_request_path(self.path)
        if normalized_path != "/api/upload":
            return self.respond_error(HTTPStatus.NOT_FOUND, "API route not found")

        return self.handle_upload(urlparse(self.path))

    def do_OPTIONS(self) -> None:
        normalized_path = self._normalize_request_path(self.path)
        if normalized_path and normalized_path.startswith("/api/public/"):
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", PUBLIC_ALLOWED_ORIGIN)
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def handle_upload(self, parsed) -> None:
        query = parse_qs(parsed.query)
        box_id = sanitize_box_id(query.get("boxId", ["UNKNOWN"])[0])
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.respond_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")

        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            return self.respond_error(HTTPStatus.BAD_REQUEST, "Expected multipart form upload")

        body = self.rfile.read(content_length) if content_length else b""
        files = self.parse_uploaded_files(content_type, body, field_name="images")

        saved_images = []
        target_dir = UPLOADS_DIR / box_id
        target_dir.mkdir(parents=True, exist_ok=True)

        for item in files:
            if not item.get("filename") or item.get("content") is None:
                continue

            filename = sanitize_filename(item["filename"])
            saved_name = f"{uuid.uuid4().hex}-{filename}"
            output_path = target_dir / saved_name
            with output_path.open("wb") as handle:
                handle.write(item["content"])

            relative_storage = output_path.relative_to(ROOT).as_posix()
            saved_images.append(
                {
                    "name": item["filename"],
                    "url": self.app_url(f"/{relative_storage}"),
                    "storagePath": relative_storage,
                }
            )

        return self.respond_json({"images": saved_images})

    def handle_health_journal_request(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        date_text = query.get("date", [journal_date_from_timestamp()])[0]
        if not self.is_valid_journal_date(date_text):
            return self.respond_error(HTTPStatus.BAD_REQUEST, "Expected date as YYYY-MM-DD")

        entries = read_health_journal(date_text)
        if not entries and date_text == journal_date_from_timestamp():
            _, entry = collect_and_journal_health("api-empty-today")
            entries = [entry]

        return self.respond_json(summarize_health_journal(entries, date_text))

    def handle_health_journal_latest(self) -> None:
        today = journal_date_from_timestamp()
        entries = read_health_journal(today)
        if not entries:
            _, entry = collect_and_journal_health("api-latest")
            entries = [entry]
        return self.respond_json(entries[-1])

    def is_valid_journal_date(self, date_text: str) -> bool:
        try:
            dt.date.fromisoformat(date_text)
        except ValueError:
            return False
        return len(date_text) == 10

    def parse_uploaded_files(self, content_type: str, body: bytes, field_name: str) -> list[dict]:
        message = BytesParser(policy=default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
        )

        files = []
        for part in message.iter_parts():
            if part.get_content_disposition() != "form-data":
                continue

            if part.get_param("name", header="content-disposition") != field_name:
                continue

            filename = part.get_filename()
            if not filename:
                continue

            files.append(
                {
                    "filename": filename,
                    "content": part.get_payload(decode=True),
                }
            )

        return files

    def handle_public_product_request(self, normalized_path: str) -> None:
        box_id = unquote(normalized_path.removeprefix("/api/public/products/")).strip().upper()
        state = load_state()
        rows = state.get("rows", [])
        details = state.get("productDetails", {})

        row = next((entry for entry in rows if str(entry.get("boxId", "")).upper() == box_id), None)
        detail = details.get(box_id, {})

        if not row and not detail:
            return self.respond_error(HTTPStatus.NOT_FOUND, "Product not found")

        payload = public_product_payload(row, detail, box_id, self)
        return self.respond_json(payload, extra_headers=self.public_cors_headers())

    def handle_public_catalog_request(self, catalog_name: str) -> None:
        catalog = CATALOGS[catalog_name]
        state = load_state()
        rows = state.get("rows", [])
        details = state.get("productDetails", {})
        rows_by_box_id = {
            str(row.get("boxId", "")).upper(): row
            for row in rows
            if str(row.get("boxId", "")).strip()
        }

        products = []
        for number in range(catalog["from"], catalog["to"] + 1):
            box_id = str(number)
            row = rows_by_box_id.get(box_id)
            detail = details.get(box_id, {})
            if not row and not detail:
                continue

            payload = public_product_payload(row, detail, box_id, self, catalog["clients"])
            payload["images"] = payload["images"][:1]
            if not has_public_catalog_content(payload):
                continue

            products.append(payload)

        clients = sorted(
            {product["client"] for product in products if product.get("client")},
            key=str.lower,
        )

        return self.respond_json(
            {
                "range": {
                    "from": catalog["from"],
                    "to": catalog["to"],
                },
                "catalog": catalog_name,
                "clients": clients,
                "products": products,
            },
            extra_headers=self.public_cors_headers(),
        )

    def read_json_body(self) -> dict | None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.respond_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")

        raw = self.rfile.read(content_length) if content_length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self.respond_error(HTTPStatus.BAD_REQUEST, "Invalid JSON body")
            return None

    def respond_json(
        self,
        payload: dict,
        status: HTTPStatus = HTTPStatus.OK,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        for header, value in JSON_HEADERS.items():
            self.send_header(header, value)
        for header, value in (extra_headers or {}).items():
            self.send_header(header, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def respond_error(self, status: HTTPStatus, message: str) -> None:
        self.respond_json({"error": message}, status=status)

    def _should_serve_index(self) -> bool:
        normalized_path = self._normalize_request_path(self.path)
        if normalized_path is None:
            return False

        resolved = Path(self.translate_path(self.path))

        if normalized_path.startswith("/api/"):
            return False

        if self._is_allowed_static(normalized_path, resolved):
            return False

        if Path(normalized_path).suffix:
            return False

        return True

    def _is_allowed_static(self, path: str, resolved: Path) -> bool:
        if not resolved.exists() or not resolved.is_file():
            return False

        if path.startswith("/app/"):
            return True

        if path.startswith("/uploads/"):
            try:
                resolved.resolve().relative_to(UPLOADS_DIR.resolve())
            except ValueError:
                return False
            return True

        try:
            resolved.resolve().relative_to(ROOT.resolve())
        except ValueError:
            return False
        return path in {"/index.html", "/README.md", "/favicon.ico"}

    def _normalize_request_path(self, raw_path: str) -> str | None:
        parsed = urlparse(raw_path)
        path = unquote(parsed.path)

        if not APP_PREFIX:
            return path

        if path == APP_PREFIX:
            return "/"

        if path.startswith(f"{APP_PREFIX}/"):
            suffix = path[len(APP_PREFIX) :]
            return suffix or "/"

        return None

    def serve_index(self, head_only: bool = False) -> None:
        content = (ROOT / "index.html").read_text(encoding="utf-8")
        body = content.replace("__APP_PREFIX__", APP_PREFIX).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def serve_health_page(self, head_only: bool = False) -> None:
        content = (ROOT / "health.html").read_text(encoding="utf-8")
        body = content.replace("__APP_PREFIX__", APP_PREFIX).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def app_url(self, path: str) -> str:
        if not APP_PREFIX:
            return path
        return f"{APP_PREFIX}{path}"

    def absolute_url(self, path: str) -> str:
        parsed = urlparse(self.path)
        headers = self.headers
        forwarded_proto = headers.get("X-Forwarded-Proto") or headers.get("CF-Visitor", "")
        scheme = "https" if "https" in forwarded_proto.lower() else "http"
        host = headers.get("X-Forwarded-Host") or headers.get("Host") or f"127.0.0.1:{PORT}"
        clean_path = path if path.startswith("/") else f"/{path}"
        return f"{scheme}://{host}{clean_path}"

    def public_cors_headers(self) -> dict[str, str]:
        return {
            "Access-Control-Allow-Origin": PUBLIC_ALLOWED_ORIGIN,
            "Vary": "Origin",
        }

    def redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.end_headers()


if __name__ == "__main__":
    ensure_app_storage()
    with ThreadingHTTPServer((HOST, PORT), SellerDashboardHandler) as server:
        display_path = f"{APP_PREFIX}/" if APP_PREFIX else "/"
        print(f"Seller Dashboard running at http://{HOST}:{PORT}{display_path}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")

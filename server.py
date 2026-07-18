from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import datetime as dt
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from email.parser import BytesParser
from email.policy import default
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent


def load_env_file(path: Path) -> None:
    """Load simple KEY=VALUE lines from a local .env into os.environ.

    Convenience for manual/local runs so `python3 server.py` picks up secrets like
    SELLER_ADMIN_PASSWORD without exporting them by hand. In production the systemd
    unit supplies these via its EnvironmentFile. Existing environment variables win,
    so this never overrides values set by systemd or the shell.
    """
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


load_env_file(ROOT / ".env")

DATA_DIR = ROOT / "data"
UPLOADS_DIR = ROOT / "uploads"
DB_PATH = DATA_DIR / "seller_dashboard.db"
HEALTH_JOURNAL_DIR = DATA_DIR / "health-journal"
LUCY_DATA_DIR = DATA_DIR / "lucy"
LUCY_TRACKED_DIR = ROOT / "lucy"
LUCY_LATEST_PATH = LUCY_DATA_DIR / "latest.json"
LUCY_TRACKED_INSIGHTS_PATH = LUCY_TRACKED_DIR / "insights.json"
NVME_BACKUP_ROOT = Path("/srv/seller-dashboard-backup")
NVME_BACKUP_CURRENT = NVME_BACKUP_ROOT / "current"
NVME_BACKUP_LAST_SUCCESS = NVME_BACKUP_ROOT / "last-success.txt"
HOST = os.environ.get("SELLER_DASHBOARD_HOST", "0.0.0.0")
PORT = int(os.environ.get("SELLER_DASHBOARD_PORT", "8000"))
BASE_PATH = os.environ.get("SELLER_DASHBOARD_BASE_PATH", "").strip()
PUBLIC_ALLOWED_ORIGIN = os.environ.get("SELLER_PUBLIC_ALLOWED_ORIGIN", "*").strip() or "*"
JSON_HEADERS = {"Content-Type": "application/json; charset=utf-8"}

# Admin auth. When SELLER_ADMIN_PASSWORD is set, the dashboard and its edit APIs
# require a signed cookie from /api/login. When empty, the app runs open (previous
# behaviour); the public API still hides "hidden" items regardless.
ADMIN_PASSWORD = os.environ.get("SELLER_ADMIN_PASSWORD", "").strip()
AUTH_REQUIRED = bool(ADMIN_PASSWORD)
LUCY_WRITE_TOKEN = os.environ.get("LUCY_WRITE_TOKEN", "").strip()
COOKIE_NAME = "sd_admin"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 10  # ~10 years — "stay signed in" for personal use
# Freshly uploaded images are protected from orphan-cleanup for this long (see delete_uploaded_file).
UPLOAD_DELETE_GRACE_SECONDS = 15 * 60
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
COOKIE_PATH = f"{APP_PREFIX}/" if APP_PREFIX else "/"


def auth_token() -> str:
    # Stable token derived from the password; comparing the cookie to this keeps the
    # session valid indefinitely without server-side session storage.
    return hashlib.sha256(f"seller-dashboard:{ADMIN_PASSWORD}".encode("utf-8")).hexdigest()


AUTH_TOKEN = auth_token() if AUTH_REQUIRED else ""

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
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS app_state_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT 'save',
                label TEXT NOT NULL DEFAULT '',
                rows_json TEXT NOT NULL,
                product_details_json TEXT NOT NULL,
                meta_json TEXT NOT NULL,
                row_count INTEGER NOT NULL DEFAULT 0,
                state_hash TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_app_state_snapshots_created_at ON app_state_snapshots (created_at)"
        )
        connection.commit()
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS order_process_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        for key, value in (
            ("rows", "[]"),
            ("meta", "{}"),
        ):
            connection.execute(
                "INSERT OR IGNORE INTO order_process_state (key, value) VALUES (?, ?)",
                (key, value),
            )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS order_process_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT 'save',
                label TEXT NOT NULL DEFAULT '',
                rows_json TEXT NOT NULL,
                meta_json TEXT NOT NULL,
                row_count INTEGER NOT NULL DEFAULT 0,
                state_hash TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_order_process_snapshots_created_at
            ON order_process_snapshots (created_at)
            """
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


def load_order_process_state() -> dict:
    ensure_app_storage()

    with sqlite3.connect(DB_PATH) as connection:
        values = {}
        for key, value in connection.execute("SELECT key, value FROM order_process_state"):
            values[key] = json.loads(value)

    return {
        "rows": values.get("rows", []),
        "meta": values.get("meta", {}),
    }


def order_process_state_hash(state: dict) -> str:
    payload = json.dumps(
        {
            "rows": state.get("rows", []),
            "meta": state.get("meta", {}),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def create_order_process_snapshot(state: dict, reason: str = "save") -> None:
    ensure_app_storage()
    next_hash = order_process_state_hash(state)
    rows = state.get("rows", [])
    meta = state.get("meta", {})
    created_at = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    snapshot_date = created_at[:10]
    source_name = str(meta.get("lastImportName") or "").strip() if isinstance(meta, dict) else ""
    label = f"Order process refresh: {source_name}" if source_name else "Order process refresh"
    is_sheet_import = reason == "sheet-import"

    with sqlite3.connect(DB_PATH) as connection:
        latest = connection.execute(
            "SELECT state_hash FROM order_process_snapshots ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if latest and latest[0] == next_hash:
            return

        if is_sheet_import:
            existing = connection.execute(
                """
                SELECT id, state_hash
                FROM order_process_snapshots
                WHERE reason = 'sheet-import'
                  AND date(created_at) = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (snapshot_date,),
            ).fetchone()
            if existing:
                if existing[1] == next_hash:
                    return
                connection.execute(
                    """
                    UPDATE order_process_snapshots
                    SET created_at = ?,
                        label = ?,
                        rows_json = ?,
                        meta_json = ?,
                        row_count = ?,
                        state_hash = ?
                    WHERE id = ?
                    """,
                    (
                        created_at,
                        label,
                        json.dumps(rows),
                        json.dumps(meta),
                        len(rows) if isinstance(rows, list) else 0,
                        next_hash,
                        existing[0],
                    ),
                )
                connection.commit()
                return

        connection.execute(
            """
            INSERT INTO order_process_snapshots (
                created_at, reason, label, rows_json, meta_json, row_count, state_hash
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                created_at,
                reason,
                label,
                json.dumps(rows),
                json.dumps(meta),
                len(rows) if isinstance(rows, list) else 0,
                next_hash,
            ),
        )
        connection.commit()


def ensure_initial_order_process_snapshot(state: dict) -> None:
    ensure_app_storage()
    with sqlite3.connect(DB_PATH) as connection:
        count = connection.execute("SELECT COUNT(*) FROM order_process_snapshots").fetchone()[0]
    if count == 0 and state.get("rows"):
        create_order_process_snapshot(state, "initial")


def save_order_process_state(state: dict, reason: str = "save") -> None:
    ensure_app_storage()
    previous_state = load_order_process_state()
    ensure_initial_order_process_snapshot(previous_state)
    next_rows = state.get("rows", [])
    next_meta = state.get("meta", {})

    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(
            "UPDATE order_process_state SET value = ? WHERE key = 'rows'",
            (json.dumps(next_rows),),
        )
        connection.execute(
            "UPDATE order_process_state SET value = ? WHERE key = 'meta'",
            (json.dumps(next_meta),),
        )
        connection.commit()

    create_order_process_snapshot(
        {
            "rows": next_rows,
            "meta": next_meta,
        },
        reason,
    )


def list_order_process_snapshots(limit: int = 365) -> list[dict]:
    ensure_app_storage()
    with sqlite3.connect(DB_PATH) as connection:
        rows = connection.execute(
            """
            SELECT id, created_at, reason, label, row_count
            FROM order_process_snapshots
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [
        {
            "id": f"process:{row[0]}",
            "createdAt": row[1],
            "date": row[1][:10],
            "reason": row[2],
            "label": row[3],
            "rowCount": row[4],
        }
        for row in rows
    ]


def load_order_process_snapshot(history_id: str) -> dict | None:
    if not history_id.startswith("process:"):
        return None
    try:
        snapshot_id = int(history_id.split(":", 1)[1])
    except ValueError:
        return None

    ensure_app_storage()
    with sqlite3.connect(DB_PATH) as connection:
        row = connection.execute(
            """
            SELECT id, created_at, reason, label, rows_json, meta_json
            FROM order_process_snapshots
            WHERE id = ?
            """,
            (snapshot_id,),
        ).fetchone()

    if not row:
        return None

    return {
        "rows": json.loads(row[4]),
        "meta": json.loads(row[5]),
        "snapshot": {
            "id": f"process:{row[0]}",
            "createdAt": row[1],
            "date": row[1][:10],
            "reason": row[2],
            "label": row[3],
        },
    }


def snapshot_state_hash(state: dict) -> str:
    payload = json.dumps(
        {
            "rows": state.get("rows", []),
            "productDetails": state.get("productDetails", {}),
            "meta": state.get("meta", {}),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def snapshot_label(reason: str, meta: dict) -> str:
    if reason == "csv-import":
        name = str(meta.get("lastImportName") or "").strip()
        if meta.get("lastImportSource") == "automated-google-sheet":
            return f"Google Sheet refresh: {name}" if name else "Google Sheet refresh"
        return f"CSV import: {name}" if name else "CSV import"
    if reason == "initial":
        return "Initial history snapshot"
    return "Dashboard save"


def create_state_snapshot(state: dict, reason: str = "save") -> None:
    ensure_app_storage()
    next_hash = snapshot_state_hash(state)
    rows = state.get("rows", [])
    details = state.get("productDetails", {})
    meta = state.get("meta", {})
    created_at = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    snapshot_date = created_at[:10]
    label = snapshot_label(reason, meta if isinstance(meta, dict) else {})
    is_automated_import = (
        reason == "csv-import"
        and isinstance(meta, dict)
        and meta.get("lastImportSource") == "automated-google-sheet"
    )

    with sqlite3.connect(DB_PATH) as connection:
        latest = connection.execute(
            "SELECT state_hash FROM app_state_snapshots ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if latest and latest[0] == next_hash:
            return

        if is_automated_import:
            existing = connection.execute(
                """
                SELECT id, state_hash
                FROM app_state_snapshots
                WHERE reason = 'csv-import'
                  AND date(created_at) = ?
                  AND json_extract(meta_json, '$.lastImportSource') = 'automated-google-sheet'
                ORDER BY id DESC
                LIMIT 1
                """,
                (snapshot_date,),
            ).fetchone()
            if existing:
                if existing[1] == next_hash:
                    return
                connection.execute(
                    """
                    UPDATE app_state_snapshots
                    SET created_at = ?,
                        label = ?,
                        rows_json = ?,
                        product_details_json = ?,
                        meta_json = ?,
                        row_count = ?,
                        state_hash = ?
                    WHERE id = ?
                    """,
                    (
                        created_at,
                        label,
                        json.dumps(rows),
                        json.dumps(details),
                        json.dumps(meta),
                        len(rows) if isinstance(rows, list) else 0,
                        next_hash,
                        existing[0],
                    ),
                )
                connection.commit()
                return

        connection.execute(
            """
            INSERT INTO app_state_snapshots (
                created_at, reason, label, rows_json, product_details_json, meta_json, row_count, state_hash
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                created_at,
                reason,
                label,
                json.dumps(rows),
                json.dumps(details),
                json.dumps(meta),
                len(rows) if isinstance(rows, list) else 0,
                next_hash,
            ),
        )
        connection.commit()


def ensure_initial_history_snapshot(state: dict) -> None:
    ensure_app_storage()
    with sqlite3.connect(DB_PATH) as connection:
        count = connection.execute("SELECT COUNT(*) FROM app_state_snapshots").fetchone()[0]
    if count == 0:
        create_state_snapshot(state, "initial")


def list_state_snapshots(limit: int = 365) -> list[dict]:
    ensure_app_storage()
    entries: list[dict] = []
    with sqlite3.connect(DB_PATH) as connection:
        rows = connection.execute(
            """
            SELECT id, created_at, reason, label, row_count
            FROM app_state_snapshots
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    for row in rows:
        entries.append(
            {
                "id": f"snapshot:{row[0]}",
                "source": "snapshot",
                "createdAt": row[1],
                "date": row[1][:10],
                "reason": row[2],
                "label": row[3],
                "rowCount": row[4],
            }
        )

    entries.extend(list_backup_snapshots())
    latest_by_date: dict[str, dict] = {}
    for entry in entries:
        date = entry.get("date", "")
        if not date:
            continue
        existing = latest_by_date.get(date)
        if existing is None or entry.get("createdAt", "") > existing.get("createdAt", ""):
            latest_by_date[date] = entry

    return sorted(latest_by_date.values(), key=lambda item: item["createdAt"], reverse=True)[:limit]


def list_backup_snapshots() -> list[dict]:
    backup_dir = DATA_DIR / "backups"
    if not backup_dir.exists():
        return []

    latest_by_date: dict[str, tuple[Path, str]] = {}
    for backup_path in sorted(backup_dir.glob("seller_dashboard-*.db")):
        created_at = backup_created_at(backup_path)
        date = created_at[:10]
        existing = latest_by_date.get(date)
        if existing is None or created_at > existing[1]:
            latest_by_date[date] = (backup_path, created_at)

    entries: list[dict] = []
    for backup_path, created_at in latest_by_date.values():
        row_count = backup_row_count(backup_path)
        entries.append(
            {
                "id": f"backup:{backup_path.name}",
                "source": "backup",
                "createdAt": created_at,
                "date": created_at[:10],
                "reason": "sqlite-backup",
                "label": "SQLite backup",
                "rowCount": row_count,
            }
        )
    return entries


def backup_created_at(path: Path) -> str:
    stem = path.stem
    prefix = "seller_dashboard-"
    if stem.startswith(prefix):
        stamp = stem[len(prefix) :]
        try:
            parsed = dt.datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
            return parsed.astimezone().isoformat(timespec="seconds")
        except ValueError:
            pass
    return dt.datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec="seconds")


def backup_row_count(path: Path) -> int:
    try:
        state = load_state_from_db(path)
    except Exception:
        return 0
    rows = state.get("rows", [])
    return len(rows) if isinstance(rows, list) else 0


def load_state_from_db(path: Path) -> dict:
    with sqlite3.connect(path) as connection:
        rows = {}
        for key, value in connection.execute("SELECT key, value FROM app_state"):
            rows[key] = json.loads(value)

    return {
        "rows": rows.get("rows", []),
        "productDetails": rows.get("productDetails", {}),
        "meta": rows.get("meta", {}),
    }


def load_history_state(history_id: str) -> dict | None:
    if history_id.startswith("snapshot:"):
        try:
            snapshot_id = int(history_id.split(":", 1)[1])
        except ValueError:
            return None
        return load_snapshot_state(snapshot_id)

    if history_id.startswith("backup:"):
        backup_name = history_id.split(":", 1)[1]
        backup_path = (DATA_DIR / "backups" / backup_name).resolve()
        try:
            backup_path.relative_to((DATA_DIR / "backups").resolve())
        except ValueError:
            return None
        if not backup_path.exists() or not backup_path.is_file():
            return None

        state = load_state_from_db(backup_path)
        created_at = backup_created_at(backup_path)
        return {
            **state,
            "snapshot": {
                "id": history_id,
                "createdAt": created_at,
                "date": created_at[:10],
                "reason": "sqlite-backup",
                "label": "SQLite backup",
            },
        }

    return None


def load_snapshot_state(snapshot_id: int) -> dict | None:
    ensure_app_storage()
    with sqlite3.connect(DB_PATH) as connection:
        row = connection.execute(
            """
            SELECT id, created_at, reason, label, rows_json, product_details_json, meta_json
            FROM app_state_snapshots
            WHERE id = ?
            """,
            (snapshot_id,),
        ).fetchone()

    if not row:
        return None

    return {
        "rows": json.loads(row[4]),
        "productDetails": json.loads(row[5]),
        "meta": json.loads(row[6]),
        "snapshot": {
            "id": f"snapshot:{row[0]}",
            "createdAt": row[1],
            "date": row[1][:10],
            "reason": row[2],
            "label": row[3],
        },
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


def nvme_backup_health() -> dict:
    if not NVME_BACKUP_ROOT.exists():
        return status_item("bad", "NVMe backup mirror", "Missing", str(NVME_BACKUP_ROOT))
    mount_code, mount_output = run_command(["findmnt", "-rn", "--target", str(NVME_BACKUP_ROOT)])
    if mount_code != 0:
        return status_item("bad", "NVMe backup mirror", "Not mounted", str(NVME_BACKUP_ROOT))
    if not NVME_BACKUP_LAST_SUCCESS.exists():
        return status_item("bad", "NVMe backup mirror", "No successful run", str(NVME_BACKUP_LAST_SUCCESS))

    latest = NVME_BACKUP_LAST_SUCCESS.stat()
    age_minutes = max(0, int((time.time() - latest.st_mtime) // 60))
    if age_minutes <= 90:
        state = "ok"
    elif age_minutes <= 180:
        state = "warn"
    else:
        state = "bad"
    backup_size = directory_size(NVME_BACKUP_CURRENT)
    detail_parts = [f"{bytes_human(backup_size)} mirrored"]
    if mount_output:
        detail_parts.append(mount_output.split()[0])
    return status_item(state, "NVMe backup mirror", f"{age_minutes} min old", ", ".join(detail_parts))


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
            service_health("seller-dashboard-nvme-backup.timer"),
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
            nvme_backup_health(),
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


def default_lucy_insights() -> dict:
    now = local_now().isoformat(timespec="seconds")
    return {
        "schemaVersion": 1,
        "generatedAt": "",
        "publishedAt": "",
        "status": "empty",
        "headline": "Lucy has not published an analysis yet.",
        "summary": "The Lucy analyst worker will publish inventory, unit-health, and dashboard-health insights here after it runs.",
        "cards": [],
        "sections": [
            {
                "title": "Waiting for first analysis",
                "summary": "Install and run scripts/lucy-analyst.py to create the first private dashboard note.",
                "items": [
                    {
                        "label": "Next step",
                        "value": "Run Lucy analyst",
                        "detail": "python3 scripts/lucy-analyst.py --write",
                        "severity": "watch",
                    }
                ],
            }
        ],
        "actions": [],
        "source": {"kind": "default", "generatedAt": now},
    }


def load_lucy_insights() -> dict:
    for path in (LUCY_LATEST_PATH, LUCY_TRACKED_INSIGHTS_PATH):
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict):
            return payload
    return default_lucy_insights()


def save_lucy_insights(payload: dict, source: str = "api") -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Lucy insight payload must be a JSON object")

    now = local_now().isoformat(timespec="seconds")
    next_payload = {
        "schemaVersion": 1,
        **payload,
        "publishedAt": payload.get("publishedAt") or now,
        "source": {
            **(payload.get("source") if isinstance(payload.get("source"), dict) else {}),
            "publishedBy": source,
        },
    }

    LUCY_DATA_DIR.mkdir(parents=True, exist_ok=True)
    LUCY_TRACKED_DIR.mkdir(parents=True, exist_ok=True)
    body = json.dumps(next_payload, indent=2, sort_keys=True) + "\n"
    LUCY_LATEST_PATH.write_text(body, encoding="utf-8")
    LUCY_TRACKED_INSIGHTS_PATH.write_text(body, encoding="utf-8")

    journal_path = LUCY_DATA_DIR / f"{journal_date_from_timestamp()}.jsonl"
    with journal_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(next_payload, separators=(",", ":")) + "\n")

    return next_payload


def save_state(state: dict, reason: str = "save") -> None:
    ensure_app_storage()
    previous_state = load_state()
    ensure_initial_history_snapshot(previous_state)
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
    create_state_snapshot(
        {
            "rows": next_rows,
            "productDetails": next_details,
            "meta": next_meta,
        },
        reason,
    )


def cleanup_orphaned_uploads(previous_details: dict, next_details: dict) -> None:
    previous_paths = extract_uploaded_paths(previous_details)
    next_paths = extract_uploaded_paths(next_details)
    protected_paths = next_paths | extract_snapshot_uploaded_paths()

    for orphan_path in previous_paths - protected_paths:
        delete_uploaded_file(orphan_path)

    cleanup_unreferenced_uploads(protected_paths)


def extract_snapshot_uploaded_paths() -> set[str]:
    ensure_app_storage()
    paths: set[str] = set()
    with sqlite3.connect(DB_PATH) as connection:
        rows = connection.execute("SELECT product_details_json FROM app_state_snapshots").fetchall()

    for (details_json,) in rows:
        try:
            details = json.loads(details_json)
        except json.JSONDecodeError:
            continue
        paths.update(extract_uploaded_paths(details))

    return paths


def cleanup_unreferenced_uploads(referenced_paths: set[str]) -> None:
    if not UPLOADS_DIR.exists():
        return

    for candidate in UPLOADS_DIR.rglob("*"):
        if not candidate.is_file():
            continue

        try:
            relative_path = candidate.resolve().relative_to(ROOT).as_posix()
        except ValueError:
            continue

        if relative_path in referenced_paths:
            continue

        try:
            if time.time() - candidate.stat().st_mtime < UPLOAD_DELETE_GRACE_SECONDS:
                continue
        except OSError:
            continue

        candidate.unlink()
        remove_empty_parent_dirs(candidate.parent)


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
        # Safety net: never delete a file that was written very recently. Saves overwrite the
        # whole state, so a stale/racy client save could momentarily omit a just-uploaded image
        # and orphan it here. Skipping fresh files means the next (correct) save re-references it
        # instead of it being deleted. Genuinely removed images are cleaned once they age out.
        try:
            if time.time() - candidate.stat().st_mtime < UPLOAD_DELETE_GRACE_SECONDS:
                return
        except OSError:
            pass
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


def normalize_box_id(value: object) -> str:
    return str(value or "").strip().upper()


def find_detail_key(details: dict, box_id: object) -> str:
    normalized = normalize_box_id(box_id)
    if not normalized or not isinstance(details, dict):
        return ""
    for key in details.keys():
        if normalize_box_id(key) == normalized:
            return str(key)
    return ""


def resolve_product_source_box_id(details: dict, box_id: object) -> str:
    if not isinstance(details, dict):
        return str(box_id or "").strip()

    key = find_detail_key(details, box_id)
    if not key:
        return str(box_id or "").strip()

    seen = {normalize_box_id(key)}
    current_key = key
    for _ in range(20):
        detail = details.get(current_key, {})
        if not isinstance(detail, dict):
            break
        source_key = find_detail_key(details, detail.get("sourceBoxId"))
        normalized_source = normalize_box_id(source_key)
        if not source_key or not normalized_source or normalized_source in seen:
            break
        seen.add(normalized_source)
        current_key = source_key

    return current_key


def same_unit_quantity(details: dict, box_id: object) -> int:
    if not isinstance(details, dict):
        return 1
    source_key = resolve_product_source_box_id(details, box_id)
    if not source_key:
        return 1
    count = 0
    for key in details.keys():
        if normalize_box_id(resolve_product_source_box_id(details, key)) == normalize_box_id(source_key):
            count += 1
    return max(1, count)


def resolve_product_detail(details: dict, box_id: object) -> dict:
    if not isinstance(details, dict):
        return {}

    key = find_detail_key(details, box_id)
    if not key:
        return {}
    direct = details.get(key, {})
    if not isinstance(direct, dict):
        direct = {}

    seen = {normalize_box_id(key)}
    current = direct
    for _ in range(20):
        source = find_detail_key(details, current.get("sourceBoxId"))
        normalized_source = normalize_box_id(source)
        if not source or not normalized_source or normalized_source in seen:
            break
        source_detail = details.get(source, {})
        if not isinstance(source_detail, dict):
            break
        seen.add(normalized_source)
        current = source_detail

    if current is direct:
        return {**direct, "boxId": key, "sourceBoxId": ""}

    return {
        **direct,
        "title": current.get("title", ""),
        "description": current.get("description", ""),
        "images": current.get("images", []),
        "updatedAt": current.get("updatedAt") or direct.get("updatedAt", ""),
        "sourceBoxId": current.get("boxId") or source,
        "boxId": key,
    }


def public_product_payload(
    row: dict | None,
    detail: dict,
    box_id: str,
    request_handler,
    client_brands: tuple[str, ...] = APPAREL_BRANDS,
    quantity: int = 1,
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
        "sourceBoxId": detail.get("sourceBoxId", ""),
        "quantity": quantity,
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

        if normalized_path == "/api/session":
            return self.respond_json(
                {"authenticated": self.is_authenticated(), "authRequired": AUTH_REQUIRED}
            )

        if normalized_path == "/api/state":
            if not self.require_auth():
                return None
            return self.respond_json(load_state())

        if normalized_path == "/api/history":
            if not self.require_auth():
                return None
            ensure_initial_history_snapshot(load_state())
            return self.respond_json({"snapshots": list_state_snapshots()})

        if normalized_path == "/api/history/state":
            if not self.require_auth():
                return None
            query = parse_qs(urlparse(self.path).query)
            history_id = query.get("id", [""])[0]
            if not history_id:
                return self.respond_error(HTTPStatus.BAD_REQUEST, "Invalid history id")
            snapshot = load_history_state(history_id)
            if snapshot is None:
                return self.respond_error(HTTPStatus.NOT_FOUND, "Snapshot not found")
            return self.respond_json(snapshot)

        if normalized_path == "/api/order-process":
            if not self.require_auth():
                return None
            return self.respond_json(load_order_process_state())

        if normalized_path == "/api/order-process/history":
            if not self.require_auth():
                return None
            state = load_order_process_state()
            ensure_initial_order_process_snapshot(state)
            return self.respond_json({"snapshots": list_order_process_snapshots()})

        if normalized_path == "/api/order-process/history/state":
            if not self.require_auth():
                return None
            query = parse_qs(urlparse(self.path).query)
            history_id = query.get("id", [""])[0]
            if not history_id:
                return self.respond_error(HTTPStatus.BAD_REQUEST, "Invalid process history id")
            snapshot = load_order_process_snapshot(history_id)
            if snapshot is None:
                return self.respond_error(HTTPStatus.NOT_FOUND, "Process snapshot not found")
            return self.respond_json(snapshot)

        if normalized_path == "/api/ping":
            return self.respond_json({"ok": True})

        if normalized_path == "/api/health":
            payload, entry = collect_and_journal_health("api")
            payload["journalEntry"] = {
                "recordedAt": entry["recordedAt"],
                "date": entry["date"],
            }
            return self.respond_json(payload)

        if normalized_path == "/api/lucy/insights":
            if not self.require_auth():
                return None
            return self.respond_json(load_lucy_insights())

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

        if normalized_path == "/api/lucy/insights":
            if not self.has_lucy_write_access():
                return

            payload = self.read_json_body()
            if payload is None:
                return
            try:
                saved = save_lucy_insights(payload, "api")
            except ValueError as error:
                return self.respond_error(HTTPStatus.BAD_REQUEST, str(error))
            return self.respond_json({"ok": True, "insights": saved})

        if normalized_path != "/api/state":
            return self.respond_error(HTTPStatus.NOT_FOUND, "API route not found")

        if not self.require_auth():
            return

        payload = self.read_json_body()
        if payload is None:
            return

        save_state(
            {
                "rows": payload.get("rows", []),
                "productDetails": payload.get("productDetails", {}),
                "meta": payload.get("meta", {}),
            },
            str(payload.get("saveReason") or "save"),
        )
        return self.respond_json({"ok": True})

    def do_POST(self) -> None:
        normalized_path = self._normalize_request_path(self.path)

        if normalized_path == "/api/login":
            return self.handle_login()

        if normalized_path == "/api/logout":
            return self.handle_logout()

        if normalized_path == "/api/import/google-sheet":
            if not self.require_auth():
                return None
            return self.handle_google_sheet_import()

        if normalized_path == "/api/order-process/import":
            if not self.require_auth():
                return None
            return self.handle_order_process_import()

        if normalized_path == "/api/upload":
            if not self.require_auth():
                return None
            return self.handle_upload(urlparse(self.path))

        if normalized_path == "/api/lucy/analyze":
            if not self.require_auth():
                return None
            return self.handle_lucy_analyze()

        return self.respond_error(HTTPStatus.NOT_FOUND, "API route not found")

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

    def is_authenticated(self) -> bool:
        if not AUTH_REQUIRED:
            return True

        cookie_header = self.headers.get("Cookie", "")
        if not cookie_header:
            return False

        cookies = SimpleCookie()
        try:
            cookies.load(cookie_header)
        except CookieError:
            return False

        morsel = cookies.get(COOKIE_NAME)
        if morsel is None:
            return False

        return hmac.compare_digest(morsel.value, AUTH_TOKEN)

    def require_auth(self) -> bool:
        if self.is_authenticated():
            return True
        self.respond_error(HTTPStatus.UNAUTHORIZED, "Authentication required")
        return False

    def has_lucy_write_access(self) -> bool:
        if self.is_authenticated():
            return True

        if LUCY_WRITE_TOKEN:
            supplied = self.headers.get("X-Lucy-Token", "")
            auth_header = self.headers.get("Authorization", "")
            if auth_header.lower().startswith("bearer "):
                supplied = auth_header[7:].strip()
            if hmac.compare_digest(supplied, LUCY_WRITE_TOKEN):
                return True

        self.respond_error(HTTPStatus.UNAUTHORIZED, "Lucy write access required")
        return False

    def handle_login(self) -> None:
        payload = self.read_json_body()
        if payload is None:
            return

        if not AUTH_REQUIRED:
            return self.respond_json({"ok": True, "authRequired": False})

        password = str(payload.get("password", ""))
        if not hmac.compare_digest(password, ADMIN_PASSWORD):
            return self.respond_error(HTTPStatus.UNAUTHORIZED, "Incorrect password")

        return self.respond_json(
            {"ok": True},
            extra_headers={"Set-Cookie": self.build_session_cookie(AUTH_TOKEN, COOKIE_MAX_AGE)},
        )

    def handle_logout(self) -> None:
        return self.respond_json(
            {"ok": True}, extra_headers={"Set-Cookie": self.build_session_cookie("", 0)}
        )

    def handle_google_sheet_import(self) -> None:
        script = ROOT / "scripts" / "import-google-sheet-csv.py"
        try:
            result = subprocess.run(
                [sys.executable, str(script)],
                cwd=str(ROOT),
                env=os.environ.copy(),
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return self.respond_error(HTTPStatus.GATEWAY_TIMEOUT, "Google Sheet refresh timed out.")
        except OSError as error:
            return self.respond_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Google Sheet refresh failed: {error}")

        if result.returncode != 0:
            message = (result.stderr or result.stdout or "Google Sheet refresh failed.").strip()
            return self.respond_error(HTTPStatus.INTERNAL_SERVER_ERROR, message)

        state = load_state()
        rows = state.get("rows", [])
        meta = state.get("meta", {}) if isinstance(state.get("meta"), dict) else {}
        return self.respond_json(
            {
                "ok": True,
                "rowCount": len(rows) if isinstance(rows, list) else 0,
                "lastImportAt": meta.get("lastImportAt", ""),
                "lastImportName": meta.get("lastImportName", ""),
                "message": (result.stdout or "Imported Google Sheet.").strip(),
            }
        )

    def handle_order_process_import(self) -> None:
        script = ROOT / "scripts" / "import-order-process-sheet.py"
        try:
            result = subprocess.run(
                [sys.executable, str(script)],
                cwd=str(ROOT),
                env=os.environ.copy(),
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return self.respond_error(
                HTTPStatus.GATEWAY_TIMEOUT,
                "Order process Google Sheet refresh timed out.",
            )
        except OSError as error:
            return self.respond_error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                f"Order process Google Sheet refresh failed: {error}",
            )

        if result.returncode != 0:
            message = (
                result.stderr or result.stdout or "Order process Google Sheet refresh failed."
            ).strip()
            return self.respond_error(HTTPStatus.INTERNAL_SERVER_ERROR, message)

        state = load_order_process_state()
        rows = state.get("rows", [])
        meta = state.get("meta", {}) if isinstance(state.get("meta"), dict) else {}
        return self.respond_json(
            {
                "ok": True,
                "rowCount": len(rows) if isinstance(rows, list) else 0,
                "lastImportAt": meta.get("lastImportAt", ""),
                "lastImportName": meta.get("lastImportName", ""),
                "message": (result.stdout or "Imported order process Google Sheet.").strip(),
            }
        )

    def handle_lucy_analyze(self) -> None:
        script = ROOT / "scripts" / "lucy-analyst.py"
        try:
            result = subprocess.run(
                [sys.executable, str(script), "--write"],
                cwd=str(ROOT),
                env=os.environ.copy(),
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return self.respond_error(HTTPStatus.GATEWAY_TIMEOUT, "Lucy analysis timed out.")
        except OSError as error:
            return self.respond_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Lucy analysis failed: {error}")

        if result.returncode != 0:
            message = (result.stderr or result.stdout or "Lucy analysis failed.").strip()
            return self.respond_error(HTTPStatus.INTERNAL_SERVER_ERROR, message)

        try:
            insights = json.loads(result.stdout or "{}")
        except json.JSONDecodeError:
            insights = load_lucy_insights()
        return self.respond_json({"ok": True, "insights": insights})

    def build_session_cookie(self, value: str, max_age: int) -> str:
        cookie = SimpleCookie()
        cookie[COOKIE_NAME] = value
        morsel = cookie[COOKIE_NAME]
        morsel["path"] = COOKIE_PATH
        morsel["max-age"] = str(max_age)
        morsel["httponly"] = True
        morsel["samesite"] = "Lax"
        return morsel.OutputString()

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
        detail = resolve_product_detail(details, box_id)

        if not row and not detail:
            return self.respond_error(HTTPStatus.NOT_FOUND, "Product not found")

        # Items flagged "hidden" in the dashboard stay fully visible to the admin but are
        # not available publicly: the public authenticity API 404s for them.
        if row and bool(row.get("hidden")):
            return self.respond_error(HTTPStatus.NOT_FOUND, "Product not found")

        payload = public_product_payload(row, detail, box_id, self, quantity=same_unit_quantity(details, box_id))
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
            detail = resolve_product_detail(details, box_id)
            if not row and not detail:
                continue

            if row and bool(row.get("hidden")):
                continue

            payload = public_product_payload(row, detail, box_id, self, catalog["clients"], same_unit_quantity(details, box_id))
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
        if AUTH_REQUIRED:
            print("Admin login required (SELLER_ADMIN_PASSWORD is set).")
        else:
            print("WARNING: no SELLER_ADMIN_PASSWORD set — the dashboard is open to anyone who can reach it.")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")

from __future__ import annotations

import json
import mimetypes
import os
import shutil
import sqlite3
import uuid
from email.parser import BytesParser
from email.policy import default
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
UPLOADS_DIR = ROOT / "uploads"
DB_PATH = DATA_DIR / "seller_dashboard.db"
HOST = os.environ.get("SELLER_DASHBOARD_HOST", "0.0.0.0")
PORT = int(os.environ.get("SELLER_DASHBOARD_PORT", "8000"))
BASE_PATH = os.environ.get("SELLER_DASHBOARD_BASE_PATH", "").strip()
PUBLIC_ALLOWED_ORIGIN = os.environ.get("SELLER_PUBLIC_ALLOWED_ORIGIN", "*").strip() or "*"
JSON_HEADERS = {"Content-Type": "application/json; charset=utf-8"}
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


def public_product_payload(row: dict | None, detail: dict, box_id: str, request_handler) -> dict:
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
        "client": detect_apparel_client(searchable_text),
        "updatedAt": detail.get("updatedAt", ""),
    }


def detect_apparel_client(text: str) -> str:
    normalized = str(text or "").lower()
    for brand in APPAREL_BRANDS:
        if brand.lower() in normalized:
            return brand
    return ""


def has_public_apparel_content(product: dict) -> bool:
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

        if normalized_path == "/api/public/apparel":
            return self.handle_public_apparel_request()

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

    def handle_public_apparel_request(self) -> None:
        state = load_state()
        rows = state.get("rows", [])
        details = state.get("productDetails", {})
        rows_by_box_id = {
            str(row.get("boxId", "")).upper(): row
            for row in rows
            if str(row.get("boxId", "")).strip()
        }

        products = []
        for number in range(APPAREL_MIN_BOX_ID, APPAREL_MAX_BOX_ID + 1):
            box_id = str(number)
            row = rows_by_box_id.get(box_id)
            detail = details.get(box_id, {})
            if not row and not detail:
                continue

            payload = public_product_payload(row, detail, box_id, self)
            payload["images"] = payload["images"][:1]
            if not has_public_apparel_content(payload):
                continue

            products.append(payload)

        clients = sorted(
            {product["client"] for product in products if product.get("client")},
            key=str.lower,
        )

        return self.respond_json(
            {
                "range": {
                    "from": APPAREL_MIN_BOX_ID,
                    "to": APPAREL_MAX_BOX_ID,
                },
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

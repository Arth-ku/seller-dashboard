#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from tkinter import ttk


APP_DIR = Path("/home/lwarm/apps/seller-dashboard")
DB_PATH = APP_DIR / "data" / "seller_dashboard.db"
BACKUP_DIR = APP_DIR / "data" / "backups"
UPLOADS_DIR = APP_DIR / "uploads"
PUBLIC_ROOT = Path("/var/www/authenticitycheck")
PUBLIC_HOST = "authenticitycheck.net"
REFRESH_SECONDS = 30

SERVICES = (
    "seller-dashboard",
    "nginx",
    "cloudflared",
    "seller-dashboard-backup.timer",
)

ENDPOINTS = (
    ("Private API", "http://127.0.0.1:8000/sell/api/state", {}),
    ("Public homepage", "http://127.0.0.1/", {"Host": PUBLIC_HOST}),
    ("Public product 620", "http://127.0.0.1/sell/api/public/products/620", {"Host": PUBLIC_HOST}),
)


def run_command(command: list[str], timeout: int = 4) -> tuple[int, str]:
    try:
        result = subprocess.run(
            command,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return 127, str(exc)
    return result.returncode, result.stdout.strip()


def http_check(url: str, headers: dict[str, str]) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "*/*", **headers})
    start = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = response.read(1024)
            elapsed_ms = int((time.monotonic() - start) * 1000)
            status = response.getcode()
    except urllib.error.HTTPError as exc:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        return {"state": "bad", "text": f"HTTP {exc.code} in {elapsed_ms} ms"}
    except Exception as exc:
        return {"state": "bad", "text": str(exc)}

    if 200 <= status < 300:
        return {"state": "ok", "text": f"HTTP {status} in {elapsed_ms} ms, data received"}
    return {"state": "warn", "text": f"HTTP {status} in {elapsed_ms} ms, {len(body)} bytes sampled"}


def bytes_human(value: int) -> str:
    amount = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if amount < 1024 or unit == "TB":
            return f"{amount:.1f} {unit}" if unit != "B" else f"{int(amount)} B"
        amount /= 1024
    return f"{value} B"


def disk_status(path: Path) -> dict:
    usage = shutil.disk_usage(path)
    free_percent = usage.free / usage.total * 100
    if free_percent < 10:
        state = "bad"
    elif free_percent < 20:
        state = "warn"
    else:
        state = "ok"
    return {
        "state": state,
        "text": f"{bytes_human(usage.free)} free of {bytes_human(usage.total)} ({free_percent:.0f}% free)",
    }


def directory_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for root, _, files in os.walk(path):
        for filename in files:
            file_path = Path(root) / filename
            try:
                total += file_path.stat().st_size
            except OSError:
                continue
    return total


def backup_status() -> dict:
    backups = sorted(BACKUP_DIR.glob("seller_dashboard-*.db"), key=lambda item: item.stat().st_mtime)
    if not backups:
        return {"state": "bad", "text": "No SQLite backups found"}

    latest = backups[-1]
    age_seconds = max(0, int(time.time() - latest.stat().st_mtime))
    age_minutes = age_seconds // 60
    state = "ok" if age_minutes <= 90 else "warn"
    return {
        "state": state,
        "text": f"Latest {age_minutes} min ago, {bytes_human(latest.stat().st_size)}, {len(backups)} retained",
    }


def database_status() -> dict:
    if not DB_PATH.exists():
        return {"state": "bad", "text": f"Missing {DB_PATH}"}
    try:
        with sqlite3.connect(DB_PATH) as connection:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            keys = connection.execute("SELECT key, length(value) FROM app_state ORDER BY key").fetchall()
    except sqlite3.Error as exc:
        return {"state": "bad", "text": str(exc)}

    state = "ok" if integrity == "ok" else "bad"
    summary = ", ".join(f"{key}:{length}" for key, length in keys)
    return {"state": state, "text": f"Integrity {integrity}; {summary}"}


def service_status(service: str) -> dict:
    active_code, active = run_command(["systemctl", "is-active", service])
    enabled_code, enabled = run_command(["systemctl", "is-enabled", service])
    if active_code == 0 and enabled_code == 0:
        state = "ok"
    elif active == "active":
        state = "warn"
    else:
        state = "bad"
    return {"state": state, "text": f"{active or 'unknown'}, {enabled or 'unknown'}"}


def cpu_temp_status() -> dict:
    path = Path("/sys/class/thermal/thermal_zone0/temp")
    try:
        celsius = int(path.read_text().strip()) / 1000
    except Exception as exc:
        return {"state": "warn", "text": f"CPU temp unavailable: {exc}"}

    if celsius >= 80:
        state = "bad"
    elif celsius >= 70:
        state = "warn"
    else:
        state = "ok"
    return {"state": state, "text": f"{celsius:.1f} C"}


def gpu_status() -> dict:
    temp_code, temp = run_command(["vcgencmd", "measure_temp"])
    throttle_code, throttle = run_command(["vcgencmd", "get_throttled"])
    parts = []
    state = "ok"

    if temp_code == 0 and temp:
        parts.append(temp.replace("temp=", "GPU/SoC temp "))
    else:
        parts.append("GPU temp unavailable")
        state = "warn"

    if throttle_code == 0 and throttle:
        parts.append(throttle)
        if not throttle.endswith("0x0"):
            state = "warn"
    else:
        parts.append("throttle status unavailable")
        state = "warn"

    return {"state": state, "text": "; ".join(parts)}


def memory_status() -> dict:
    meminfo = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, value = line.split(":", 1)
            meminfo[key] = int(value.strip().split()[0]) * 1024
    except Exception as exc:
        return {"state": "warn", "text": f"Memory unavailable: {exc}"}

    total = meminfo.get("MemTotal", 0)
    available = meminfo.get("MemAvailable", 0)
    free_percent = available / total * 100 if total else 0
    state = "bad" if free_percent < 8 else "warn" if free_percent < 15 else "ok"
    return {"state": state, "text": f"{bytes_human(available)} available of {bytes_human(total)}"}


def collect_health() -> dict[str, dict]:
    health: dict[str, dict] = {}
    health["Site storage"] = disk_status(APP_DIR)
    health["Uploads"] = {
        "state": "ok" if UPLOADS_DIR.exists() else "bad",
        "text": f"{bytes_human(directory_size(UPLOADS_DIR))} used in {UPLOADS_DIR}",
    }
    health["Public static root"] = {
        "state": "ok" if PUBLIC_ROOT.exists() else "bad",
        "text": str(PUBLIC_ROOT),
    }
    health["Database"] = database_status()
    health["Database backups"] = backup_status()
    health["CPU temp"] = cpu_temp_status()
    health["GPU / throttle"] = gpu_status()
    health["Memory"] = memory_status()

    for service in SERVICES:
        health[f"Service: {service}"] = service_status(service)

    for label, url, headers in ENDPOINTS:
        health[f"Endpoint: {label}"] = http_check(url, headers)

    return health


class HealthDashboard:
    COLORS = {
        "ok": ("#d8f5df", "#116329", "OK"),
        "warn": ("#fff0c2", "#8a5a00", "WARN"),
        "bad": ("#ffd8d8", "#9f1d1d", "BAD"),
    }

    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("Seller Dashboard Health")
        self.root.geometry("980x680")
        self.root.minsize(820, 560)

        self.status_var = tk.StringVar(value="Loading...")
        self.rows: dict[str, tuple[tk.Label, tk.Label, tk.Label]] = {}
        self.refreshing = False

        self._build()
        self.refresh()
        self.root.after(REFRESH_SECONDS * 1000, self.refresh)

    def _build(self) -> None:
        self.root.configure(bg="#f5f7fa")

        header = tk.Frame(self.root, bg="#17202a", padx=18, pady=14)
        header.pack(fill="x")

        title = tk.Label(
            header,
            text="Seller Dashboard Health",
            fg="white",
            bg="#17202a",
            font=("Sans", 20, "bold"),
        )
        title.pack(side="left")

        ttk.Button(header, text="Refresh", command=self.refresh).pack(side="right", padx=(8, 0))
        ttk.Button(header, text="Open Site", command=lambda: webbrowser.open("https://authenticitycheck.net/")).pack(
            side="right", padx=(8, 0)
        )
        ttk.Button(header, text="Open Dashboard", command=lambda: webbrowser.open("https://authenticitycheck.net/sell/")).pack(
            side="right", padx=(8, 0)
        )

        status = tk.Label(
            self.root,
            textvariable=self.status_var,
            anchor="w",
            bg="#eef2f7",
            fg="#334155",
            padx=18,
            pady=8,
            font=("Sans", 10),
        )
        status.pack(fill="x")

        outer = tk.Frame(self.root, bg="#f5f7fa")
        outer.pack(fill="both", expand=True, padx=16, pady=16)

        canvas = tk.Canvas(outer, bg="#f5f7fa", highlightthickness=0)
        scrollbar = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        self.content = tk.Frame(canvas, bg="#f5f7fa")

        self.content.bind("<Configure>", lambda _: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=self.content, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

    def refresh(self) -> None:
        if self.refreshing:
            return
        self.refreshing = True
        self.status_var.set("Refreshing...")
        threading.Thread(target=self._collect_and_render, daemon=True).start()

    def _collect_and_render(self) -> None:
        try:
            health = collect_health()
            error = None
        except Exception as exc:
            health = {}
            error = exc
        self.root.after(0, lambda: self._render(health, error))

    def _render(self, health: dict[str, dict], error: Exception | None) -> None:
        self.refreshing = False
        if error:
            self.status_var.set(f"Refresh failed: {error}")
            return

        now = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        counts = {"ok": 0, "warn": 0, "bad": 0}
        for item in health.values():
            counts[item.get("state", "warn")] = counts.get(item.get("state", "warn"), 0) + 1
        self.status_var.set(
            f"Last refresh: {now}    OK: {counts['ok']}    WARN: {counts['warn']}    BAD: {counts['bad']}"
        )

        for label in sorted(health):
            item = health[label]
            state = item.get("state", "warn")
            text = item.get("text", "")
            self._set_row(label, state, text)

        self.root.after(REFRESH_SECONDS * 1000, self.refresh)

    def _set_row(self, label: str, state: str, text: str) -> None:
        bg, fg, short = self.COLORS.get(state, self.COLORS["warn"])
        if label not in self.rows:
            row = tk.Frame(self.content, bg="white", padx=12, pady=10, highlightbackground="#d7dee8", highlightthickness=1)
            row.pack(fill="x", pady=5)

            badge = tk.Label(row, width=7, bg=bg, fg=fg, text=short, font=("Sans", 10, "bold"), padx=8, pady=4)
            badge.pack(side="left", padx=(0, 12))

            name = tk.Label(row, text=label, bg="white", fg="#101828", anchor="w", font=("Sans", 12, "bold"), width=28)
            name.pack(side="left", padx=(0, 12))

            detail = tk.Label(row, text=text, bg="white", fg="#344054", anchor="w", justify="left", wraplength=560)
            detail.pack(side="left", fill="x", expand=True)

            self.rows[label] = (badge, name, detail)
        else:
            badge, _, detail = self.rows[label]
            badge.configure(bg=bg, fg=fg, text=short)
            detail.configure(text=text)

    def run(self) -> None:
        self.root.mainloop()


def main() -> int:
    parser = argparse.ArgumentParser(description="Show Seller Dashboard site and Pi health.")
    parser.add_argument("--once", action="store_true", help="Print one health snapshot and exit.")
    args = parser.parse_args()

    if args.once:
        print(json.dumps(collect_health(), indent=2, sort_keys=True))
        return 0

    HealthDashboard().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

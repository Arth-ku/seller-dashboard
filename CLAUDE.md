# CLAUDE.md

This project's canonical agent notes live in [AGENTS.md](AGENTS.md) — read that first. It covers
the production Raspberry Pi setup, repo structure, runtime architecture, and deployment.

## Quick orientation

- Zero-dependency app: Python stdlib server (`server.py`) + vanilla-JS SPA (`app/`), SQLite storage
  (`data/`, git-ignored), images on disk (`uploads/`, git-ignored).
- Public authenticity site is separate (`cloudflare-auth/`), talking to the public API.
- No build step, no tests/CI. Verify by running `python3 server.py` and exercising the UI.

## Conventions

- Keep it dependency-free — it must run on a bare Pi Python install.
- Escape all user content rendered into HTML (`escapeHtml`/`escapeAttribute`).
- Validate any filesystem path built from a request against `ROOT`/`UPLOADS_DIR` with
  `.relative_to(...)` (see `_is_allowed_static`, `delete_uploaded_file`).
- The public API must stay minimal — never widen it to expose buyer notes or the full row.

## Auth and hidden items

Setting `SELLER_ADMIN_PASSWORD` gates the dashboard behind a signed-cookie login; `hidden` rows are
excluded from the public product/catalog APIs. Full details in [AGENTS.md](AGENTS.md#admin-login-and-hidden-items).
Secrets go in a git-ignored `.env` (local) or the systemd `EnvironmentFile` (Pi) — never committed.

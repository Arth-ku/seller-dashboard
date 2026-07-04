import {
  COLUMN_DEFS,
  createEmptyRow,
  ensureUniqueBoxId,
  extractLeadingBoxId,
  normalizeRowState,
  pruneRows,
  rowsFromCsv,
  serializeRowsToCsv,
} from "./csv.js";
import {
  fetchSession,
  loadAppState,
  loadHealth,
  login,
  logout,
  saveAppState,
  saveMeta,
  saveProductDetails,
  saveRows,
  uploadImages,
} from "./store.js";

const app = document.querySelector("#app");
const APP_CONFIG = window.__APP_CONFIG__ || {};
const BASE_PATH = normalizeBasePath(APP_CONFIG.basePath);
const DASHBOARD_COLUMNS = COLUMN_DEFS.filter(({ key }) =>
  ["boxId", "archived", "hidden", "itemName"].includes(key),
);
const MAX_IMAGES_PER_PRODUCT = 30;
const HEALTH_REFRESH_MS = 15000;
const IMPORT_PASSWORD = "wSS2008!";

// Admin catalog views. Ranges mirror CATALOGS in server.py. These are admin-only pages
// inside the dashboard (/sell/hvac, /sell/apparel) that show EVERY item in the range,
// including hidden ones. The public catalog pages on authenticitycheck.net are separate
// and still exclude hidden items.
const CATALOGS = {
  apparel: { label: "Apparel", from: 1000, to: 1100 },
  hvac: { label: "HVAC", from: 700, to: 800 },
};

const state = {
  rows: [],
  productDetails: {},
  meta: {},
  search: "",
  archiveFilter: "present",
  boxSort: "desc",
  saveMessage: "",
  session: { authenticated: false, authRequired: false },
  loginError: "",
  catalogSearch: "",
};
let healthRefreshTimer = null;

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

window.addEventListener("popstate", () => {
  render();
});

document.addEventListener("click", async (event) => {
  const link = event.target.closest("[data-route]");
  if (!link) {
    return;
  }

  event.preventDefault();
  navigate(link.getAttribute("href"));
});

init().catch((error) => {
  console.error(error);
  app.innerHTML = `
    <main class="shell">
      <section class="panel error-panel">
        <h1>Seller Dashboard</h1>
        <p>The app could not load correctly.</p>
        <pre>${escapeHtml(String(error))}</pre>
      </section>
    </main>
  `;
});

async function init() {
  state.session = await fetchSession();

  if (state.session.authRequired && !state.session.authenticated) {
    renderLogin();
    return;
  }

  await loadAndRender();
}

async function loadAndRender() {
  try {
    const stored = await loadAppState();
    state.rows = pruneRows((stored.rows || []).map(normalizeRowState));
    state.productDetails = stored.productDetails;
    state.meta = stored.meta;

    if ((stored.rows || []).length !== state.rows.length) {
      await saveRows(state.rows);
    }

    render();
  } catch (error) {
    if (error && error.unauthorized) {
      state.session = { authenticated: false, authRequired: true };
      renderLogin();
      return;
    }
    throw error;
  }
}

function renderLogin() {
  clearHealthRefresh();
  app.innerHTML = `
    <main class="shell login-shell">
      <section class="panel login-panel">
        <p class="eyebrow">Seller Dashboard</p>
        <h1>Admin sign in</h1>
        <p class="hero-text">Enter the admin password to manage inventory.</p>
        <form id="login-form" class="login-form">
          <label class="field">
            <span>Password</span>
            <input id="login-password" type="password" autocomplete="current-password" autofocus />
          </label>
          <button class="button primary" type="submit">Sign in</button>
          <p class="login-error">${escapeHtml(state.loginError)}</p>
        </form>
      </section>
    </main>
  `;

  const form = document.querySelector("#login-form");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const passwordInput = document.querySelector("#login-password");
    const password = passwordInput ? passwordInput.value : "";

    const result = await login(password);
    if (!result.ok) {
      state.loginError = result.error || "Login failed.";
      renderLogin();
      document.querySelector("#login-password")?.focus();
      return;
    }

    state.loginError = "";
    state.session = { authenticated: true, authRequired: true };
    await loadAndRender();
  });
}

async function handleSignOut() {
  await logout();
  state.session = { authenticated: false, authRequired: true };
  state.rows = [];
  state.productDetails = {};
  navigate("/");
  renderLogin();
}

function render() {
  const route = getCurrentRoute();
  app.innerHTML = "";
  clearHealthRefresh();

  if (route.page === "health") {
    renderHealthPage();
    return;
  }

  if (route.page === "catalog") {
    renderCatalogPage(route.catalog);
    return;
  }

  if (route.subpage === "authenticity" && route.boxId) {
    renderAuthenticityPage(route.boxId);
    return;
  }

  if (route.boxId) {
    renderProductDetail(route.boxId);
    return;
  }

  renderDashboard();
}

function renderHealthPage() {
  const main = document.createElement("main");
  main.className = "shell health-shell";
  main.innerHTML = `
    <section class="panel health-panel">
      <div class="detail-header">
        <div>
          <a class="back-link" data-route href="${appPath("/")}">Back to dashboard</a>
          <p class="eyebrow">System Health</p>
          <h1>Site health</h1>
          <p class="detail-subtitle">Auto-refreshes every 15 seconds. Heavy disk and database checks are cached on the server.</p>
        </div>
        <div class="health-summary" id="health-summary">
          <span class="health-badge is-warn">Loading</span>
        </div>
      </div>
      <div class="health-actions">
        <button id="health-refresh-button" class="button secondary" type="button">Refresh now</button>
        <span id="health-updated" class="muted-text">Waiting for first check...</span>
      </div>
      <div id="health-grid" class="health-grid">
        <div class="health-card is-warn">
          <span class="health-status">Loading</span>
          <h2>Checking site health...</h2>
          <p>Please wait.</p>
        </div>
      </div>
    </section>
  `;
  app.append(main);

  document.querySelector("#health-refresh-button")?.addEventListener("click", () => {
    refreshHealth({ immediate: true });
  });
  refreshHealth({ immediate: true });
}

async function refreshHealth({ immediate = false } = {}) {
  clearHealthRefresh();
  const button = document.querySelector("#health-refresh-button");
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing...";
  }

  try {
    const payload = await loadHealth();
    renderHealthPayload(payload);
  } catch (error) {
    renderHealthError(error);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Refresh now";
    }
    healthRefreshTimer = window.setTimeout(refreshHealth, HEALTH_REFRESH_MS);
  }

  if (!immediate) {
    return;
  }
}

function renderHealthPayload(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const status = payload.status || "warn";
  const counts = payload.counts || {};
  const summary = document.querySelector("#health-summary");
  const updated = document.querySelector("#health-updated");
  const grid = document.querySelector("#health-grid");

  if (summary) {
    summary.innerHTML = `
      <span class="health-badge is-${escapeAttribute(status)}">${escapeHtml(status.toUpperCase())}</span>
      <span>${escapeHtml(String(counts.ok || 0))} OK</span>
      <span>${escapeHtml(String(counts.warn || 0))} Warn</span>
      <span>${escapeHtml(String(counts.bad || 0))} Bad</span>
    `;
  }

  if (updated) {
    const collectedAt = payload.collectedAt ? new Date(payload.collectedAt * 1000) : new Date();
    updated.textContent = `Last updated ${collectedAt.toLocaleString()} · next refresh in 15 seconds`;
  }

  if (!grid) {
    return;
  }

  grid.innerHTML = items
    .map(
      (item) => `
        <article class="health-card is-${escapeAttribute(item.state || "warn")}">
          <span class="health-status">${escapeHtml(String(item.state || "warn").toUpperCase())}</span>
          <h2>${escapeHtml(item.label || "Health check")}</h2>
          <strong>${escapeHtml(item.value || "")}</strong>
          ${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}
        </article>
      `,
    )
    .join("");
}

function renderHealthError(error) {
  const summary = document.querySelector("#health-summary");
  const updated = document.querySelector("#health-updated");
  const grid = document.querySelector("#health-grid");

  if (summary) {
    summary.innerHTML = `<span class="health-badge is-bad">ERROR</span>`;
  }

  if (updated) {
    updated.textContent = `Health check failed at ${new Date().toLocaleString()}`;
  }

  if (grid) {
    grid.innerHTML = `
      <article class="health-card is-bad">
        <span class="health-status">BAD</span>
        <h2>Health endpoint failed</h2>
        <strong>Could not load /api/health</strong>
        <p>${escapeHtml(error?.message || String(error))}</p>
      </article>
    `;
  }
}

function clearHealthRefresh() {
  if (healthRefreshTimer) {
    window.clearTimeout(healthRefreshTimer);
    healthRefreshTimer = null;
  }
}

function renderCatalogPage(catalogName) {
  const catalog = CATALOGS[catalogName];
  if (!catalog) {
    navigate("/");
    return;
  }

  const term = state.catalogSearch.trim().toLowerCase();
  const items = (Array.isArray(state.rows) ? state.rows : [])
    .filter((row) => {
      const number = Number(String(row?.boxId ?? "").trim());
      return Number.isInteger(number) && number >= catalog.from && number <= catalog.to;
    })
    .filter((row) => {
      if (!term) {
        return true;
      }
      const title = state.productDetails[row.boxId]?.title || "";
      return [row.boxId, row.itemName, title, row.revised, row.priceListed]
        .join(" ")
        .toLowerCase()
        .includes(term);
    })
    .sort((left, right) => compareBoxIds(left.boxId, right.boxId, "asc"));

  const hiddenCount = items.filter((row) => row.hidden).length;

  const main = document.createElement("main");
  main.className = "shell";
  main.innerHTML = `
    <section class="panel detail-panel">
      <div class="detail-header">
        <div>
          <a class="back-link" data-route href="${appPath("/")}">Back to dashboard</a>
          <p class="eyebrow">Admin Catalog</p>
          <h1>${escapeHtml(catalog.label)}</h1>
          <p class="detail-subtitle">Box IDs ${catalog.from}–${catalog.to}. Shows every item including hidden ones. The public ${escapeHtml(catalog.label)} page hides the hidden ones.</p>
        </div>
        <div class="detail-meta">
          <span class="detail-pill">${items.length} item${items.length === 1 ? "" : "s"}</span>
          <span class="detail-pill ${hiddenCount ? "pill-hidden" : "pill-public"}">${hiddenCount} hidden</span>
          <a class="detail-pill pill-link" href="/${encodeURIComponent(catalogName)}" target="_blank" rel="noopener">Open public page ↗</a>
        </div>
      </div>

      <div class="catalog-toolbar">
        <label class="search-field">
          <span>Search ${escapeHtml(catalog.label)}</span>
          <input id="catalog-search" type="search" value="${escapeAttribute(state.catalogSearch)}" placeholder="Box ID, name, price..." />
        </label>
        <button id="catalog-add" class="button primary" type="button">Add ${escapeHtml(catalog.label)} item</button>
      </div>

      ${
        items.length
          ? `<div class="catalog-grid">${items.map(catalogCard).join("")}</div>`
          : `<div class="empty-state"><h2>No items in this range yet</h2><p>Items with a Box ID from ${catalog.from} to ${catalog.to} will appear here.</p></div>`
      }
    </section>
  `;

  app.append(main);
  bindCatalogEvents(catalogName);
}

function catalogCard(row) {
  const detail = state.productDetails[row.boxId] || createEmptyDetail(row.boxId);
  const image = detail.images && detail.images[0];
  const title =
    stripBoxIdPrefix(detail.title, row.boxId) ||
    stripBoxIdPrefix(row.itemName || "", row.boxId) ||
    "Untitled item";
  const price = (row.revised || "").trim() || (row.priceListed || "").trim() || "No price";
  const productHref = appPath(`/${encodeURIComponent(row.boxId)}`);

  return `
    <article class="catalog-card ${row.hidden ? "is-hidden-item" : ""}">
      <a class="catalog-card-media" data-route href="${productHref}">
        ${
          image
            ? `<img src="${escapeAttribute(getImageSource(image))}" alt="${escapeAttribute(title)}" loading="lazy" />`
            : `<span class="catalog-card-noimage">No photo</span>`
        }
        ${row.hidden ? `<span class="catalog-card-badge">Hidden</span>` : ""}
      </a>
      <div class="catalog-card-body">
        <div class="catalog-card-heading">
          <a class="boxid-link" data-route href="${productHref}">${escapeHtml(row.boxId)}</a>
          ${row.archived ? `<span class="detail-pill">Archived</span>` : ""}
        </div>
        <p class="catalog-card-title">${escapeHtml(title)}</p>
        <p class="catalog-card-price">${escapeHtml(price)}</p>
        <div class="catalog-card-actions">
          <label class="checkbox-wrap">
            <input type="checkbox" data-catalog-hidden="${escapeAttribute(row.boxId)}" ${row.hidden ? "checked" : ""} />
            <span>${row.hidden ? "Hidden" : "Public"}</span>
          </label>
          <a class="button-link" data-route href="${productHref}">Edit</a>
        </div>
      </div>
    </article>
  `;
}

function bindCatalogEvents(catalogName) {
  const catalog = CATALOGS[catalogName];

  document.querySelector("#catalog-add")?.addEventListener("click", async () => {
    const used = new Set(
      state.rows.map((row) => String(row?.boxId ?? "").trim()).filter(Boolean),
    );
    let nextId = null;
    for (let number = catalog.from; number <= catalog.to; number += 1) {
      if (!used.has(String(number))) {
        nextId = String(number);
        break;
      }
    }

    if (!nextId) {
      setSaveMessage(`${catalog.label} range ${catalog.from}–${catalog.to} is full — no free Box ID.`);
      render();
      return;
    }

    const row = createEmptyRow(state.rows);
    row.boxId = nextId;
    row.isDraft = true;
    state.rows = [row, ...state.rows];
    await saveRows(state.rows);
    setSaveMessage(`Added ${catalog.label} item ${nextId}. Add photos and details below.`);
    navigate(`/${encodeURIComponent(nextId)}`);
  });

  const searchInput = document.querySelector("#catalog-search");
  searchInput?.addEventListener("input", (event) => {
    state.catalogSearch = event.target.value;
    render();
    window.requestAnimationFrame(() => {
      const refreshed = document.querySelector("#catalog-search");
      if (!refreshed) {
        return;
      }
      refreshed.focus();
      refreshed.setSelectionRange(state.catalogSearch.length, state.catalogSearch.length);
    });
  });

  document.querySelectorAll("[data-catalog-hidden]").forEach((input) => {
    input.addEventListener("change", async (event) => {
      const boxId = event.target.dataset.catalogHidden;
      const row = state.rows.find((entry) => entry.boxId === boxId);
      if (!row) {
        return;
      }
      row.hidden = event.target.checked;
      await saveRows(state.rows);
      setSaveMessage(`${row.hidden ? "Hid" : "Unhid"} ${boxId} from public view.`);
      render();
    });
  });
}

function renderDashboard() {
  const main = document.createElement("main");
  main.className = "shell";

  const rows = pruneRows((Array.isArray(state.rows) ? state.rows : []).map(normalizeRowState));

  const visibleRows = rows
    .filter((row) => {
      if (!row || typeof row !== "object") {
        return false;
      }

      if (state.archiveFilter === "archived" && !row.archived) {
        return false;
      }

      if (state.archiveFilter === "present" && row.archived) {
        return false;
      }

      const term = state.search.trim().toLowerCase();
      if (!term) {
        return true;
      }

      return [row.boxId, row.itemName, row.notes, row.buyerDescription, row.soldThrough]
        .join(" ")
        .toLowerCase()
        .includes(term);
    })
    .sort((left, right) => compareBoxIds(left.boxId, right.boxId, state.boxSort));

  const summary = buildSummary(rows);
  const lastImport = state.meta.lastImportAt
    ? new Date(state.meta.lastImportAt).toLocaleString()
    : "No CSV imported yet";

  main.innerHTML = `
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Seller Dashboard</p>
        <h1>Track inventory, pricing, sales, and box details in one place.</h1>
        <p class="hero-text">
          Import your CSV, edit rows directly on the site, and open any product page to manage photos,
          title, and description.
        </p>
      </div>
      <div class="hero-stats">
        <article class="stat-card">
          <span>Total Items</span>
          <strong>${summary.totalRows}</strong>
        </article>
        <article class="stat-card">
          <span>Present</span>
          <strong>${summary.presentRows}</strong>
        </article>
        <article class="stat-card">
          <span>Archived</span>
          <strong>${summary.archivedRows}</strong>
        </article>
        <article class="stat-card">
          <span>Listed Value</span>
          <strong>${currencyFormatter.format(summary.totalListedValue)}</strong>
        </article>
      </div>
    </section>

    <section class="panel controls-panel">
      <div class="toolbar">
        <div class="toolbar-actions">
          <label class="button primary file-button">
            <input id="csv-input" type="file" accept=".csv,text/csv" />
            Import CSV
          </label>
          <button id="add-row-button" class="button secondary" type="button">Add Row</button>
          <button id="export-button" class="button ghost" type="button">Export CSV</button>
          <a class="button ghost" data-route href="${appPath("/hvac")}">HVAC</a>
          <a class="button ghost" data-route href="${appPath("/apparel")}">Apparel</a>
          <a class="button ghost" data-route href="${appPath("/health")}">Health</a>
          ${state.session.authRequired ? `<button id="sign-out-button" class="button ghost" type="button">Sign out</button>` : ""}
        </div>
        <div class="toolbar-filters">
          <label class="search-field">
            <span>Search</span>
            <input id="search-input" type="search" value="${escapeAttribute(state.search)}" placeholder="Box ID or item name..." />
          </label>
          <label class="search-field compact-field">
            <span>Archive</span>
            <select id="archive-filter">
              <option value="all" ${state.archiveFilter === "all" ? "selected" : ""}>All</option>
              <option value="present" ${state.archiveFilter === "present" ? "selected" : ""}>False / Present</option>
              <option value="archived" ${state.archiveFilter === "archived" ? "selected" : ""}>True / Archive</option>
            </select>
          </label>
          <label class="search-field compact-field">
            <span>Sort by Box ID</span>
            <select id="box-sort">
              <option value="asc" ${state.boxSort === "asc" ? "selected" : ""}>Ascending</option>
              <option value="desc" ${state.boxSort === "desc" ? "selected" : ""}>Descending</option>
            </select>
          </label>
        </div>
      </div>

      <div class="status-row">
        <p><strong>Last import:</strong> ${escapeHtml(lastImport)}</p>
        <p>${escapeHtml(state.saveMessage || "Inline row edits save automatically on the server.")}</p>
      </div>
    </section>
  `;

  const tablePanel = document.createElement("section");
  tablePanel.className = "panel table-panel";

  if (!visibleRows.length) {
    tablePanel.innerHTML = `
      <div class="empty-state">
        <h2>No rows to show</h2>
        <p>Try changing the archive filter, search, or import your CSV again.</p>
      </div>
    `;
  } else {
    tablePanel.append(buildTable(visibleRows));
  }

  main.append(tablePanel);
  app.append(main);

  bindDashboardEvents();
}

function renderProductDetail(boxId) {
  const main = document.createElement("main");
  main.className = "shell";

  const row = state.rows.find((entry) => entry.boxId === boxId);
  const detail = state.productDetails[boxId] || createEmptyDetail(boxId);
  const imageCountText = `${detail.images.length}/${MAX_IMAGES_PER_PRODUCT} images uploaded`;

  main.innerHTML = `
    <section class="panel detail-panel">
      <div class="detail-header">
        <div>
          <a class="back-link" data-route href="${appPath("/")}">Back to dashboard</a>
          <p class="eyebrow">Product Page</p>
          <h1>${escapeHtml(boxId)}</h1>
          <p class="detail-subtitle">${escapeHtml(row?.itemName || "No dashboard row found for this box yet.")}</p>
          <p class="detail-secondary-link">
            <a class="back-link" data-route href="${appPath(`/${encodeURIComponent(boxId)}/authenticity`)}">Open authenticity page</a>
          </p>
        </div>
        <div class="detail-meta">
          <span class="detail-pill">${row?.archived ? "Archived" : "Present"}</span>
          <span class="detail-pill ${row?.hidden ? "pill-hidden" : "pill-public"}">${row?.hidden ? "Hidden from public" : "Public"}</span>
          <span class="detail-pill">${escapeHtml(row?.priceListed || "No listed price")}</span>
          <span class="detail-pill">${escapeHtml(row?.soldThrough || "No sale platform")}</span>
        </div>
      </div>

      ${
        row
          ? `<div class="visibility-bar">
              <label class="checkbox-wrap">
                <input id="detail-hidden" type="checkbox" ${row.hidden ? "checked" : ""} />
                <span>Hide this item from the public authenticity page</span>
              </label>
              <p class="muted-text">When hidden, the public authenticity page and API return "not found". You still see and edit it here.</p>
            </div>`
          : ""
      }

      <div class="detail-layout">
        <div class="detail-column">
          <section class="subpanel">
            <div class="subpanel-heading">
              <h2>Photos</h2>
              <p>${escapeHtml(imageCountText)}</p>
            </div>
            <label class="upload-zone">
              <input id="image-input" type="file" accept=".webp,.jpg,.jpeg,.png,.gif,.avif,.bmp,.svg,.heic,.heif,image/webp,image/jpeg,image/png,image/gif,image/avif,image/bmp,image/svg+xml,image/heic,image/heif" multiple />
              <span>Upload up to ${MAX_IMAGES_PER_PRODUCT} images</span>
              <small>Photos are stored on the server so every device can see them. Supports webp, jpg, jpeg, png, gif, avif, bmp, svg, heic, and heif.</small>
            </label>
            <div class="image-grid">
              ${
                detail.images.length
                  ? detail.images
                      .map(
                        (image, index) => `
                          <figure class="image-card draggable-image-card" draggable="true" data-drag-image="${index}">
                            <img src="${escapeAttribute(getImageSource(image))}" alt="${escapeAttribute(image.name || `Image ${index + 1}`)}" draggable="false" />
                            <figcaption>
                              <span class="image-name">${escapeHtml(image.name || `Image ${index + 1}`)}</span>
                              <div class="image-actions">
                                <span class="drag-hint">Drag to reorder</span>
                                <button class="button-link" type="button" data-remove-image="${index}">Remove</button>
                              </div>
                            </figcaption>
                          </figure>
                        `,
                      )
                      .join("")
                  : `<p class="muted-text">No photos uploaded yet.</p>`
              }
            </div>
          </section>
        </div>

        <div class="detail-column">
          <section class="subpanel">
            <div class="subpanel-heading">
              <h2>Listing Content</h2>
              <p>Edit manually and save when ready.</p>
            </div>
            <label class="field">
              <span>Title</span>
              <input id="detail-title" type="text" value="${escapeAttribute(detail.title)}" placeholder="Write a listing title" />
            </label>
            <label class="field">
              <span>Description</span>
              <textarea id="detail-description" rows="10" placeholder="Write the item description">${escapeHtml(detail.description)}</textarea>
            </label>
            <div class="button-row">
              <button id="save-detail-button" class="button primary" type="button">Save Details</button>
              <span class="muted-text">${escapeHtml(detail.updatedAt ? `Last saved ${new Date(detail.updatedAt).toLocaleString()}` : "Not saved yet")}</span>
            </div>
          </section>

          <section class="subpanel">
            <div class="subpanel-heading">
              <h2>Dashboard Snapshot</h2>
              <p>Quick values pulled from the main table.</p>
            </div>
            <dl class="snapshot-grid">
              ${buildSnapshotRow("Item Name", row?.itemName)}
              ${buildSnapshotRow("Price Listed", row?.priceListed)}
              ${buildSnapshotRow("Revised", row?.revised)}
              ${buildSnapshotRow("Self Expense", row?.selfExpense)}
              ${buildSnapshotRow("Sold Day", row?.soldDay)}
              ${buildSnapshotRow("Final Price", row?.finalPrice)}
              ${buildSnapshotRow("Notes", row?.notes)}
            </dl>
          </section>
        </div>
      </div>
    </section>
  `;

  app.append(main);
  bindDetailEvents(boxId);
}

function renderAuthenticityPage(boxId) {
  const main = document.createElement("main");
  main.className = "shell";

  const row = state.rows.find((entry) => entry.boxId === boxId);
  const detail = state.productDetails[boxId] || createEmptyDetail(boxId);
  const displayPrice = row?.revised?.trim() || row?.priceListed?.trim() || "No price added";
  const displayTitle = stripBoxIdPrefix(detail.title, boxId);
  const displaySubtitle = stripBoxIdPrefix(row?.itemName || "", boxId);

  main.innerHTML = `
    <section class="panel authenticity-panel">
      ${
        row?.hidden
          ? `<div class="hidden-banner">This item is <strong>hidden from public view</strong>. The public authenticity page shows "not found". This is an admin preview.</div>`
          : ""
      }
      <div class="authenticity-header">
        <div>
          <p class="eyebrow">Authenticity</p>
          <h1>${escapeHtml(boxId)}</h1>
          <p class="detail-subtitle">${escapeHtml(displaySubtitle || "No item name available.")}</p>
        </div>
        <div class="detail-meta">
          <span class="detail-pill">${escapeHtml(displayPrice)}</span>
        </div>
      </div>

      <section class="authenticity-block">
        <h2>Photos</h2>
        <div class="image-grid">
          ${
            detail.images.length
              ? detail.images
                  .map(
                    (image, index) => `
                      <figure class="image-card authenticity-image-card">
                        <a
                          class="image-preview-trigger authenticity-image-link"
                          href="${escapeAttribute(getImageSource(image))}"
                          target="_blank"
                          rel="noopener noreferrer"
                          data-preview-index="${index}"
                          data-preview-image="${escapeAttribute(getImageSource(image))}"
                          data-preview-name="${escapeAttribute(image.name || `Image ${index + 1}`)}"
                        >
                          <img src="${escapeAttribute(getImageSource(image))}" alt="${escapeAttribute(image.name || `Image ${index + 1}`)}" draggable="false" />
                        </a>
                      </figure>
                    `,
                  )
                  .join("")
              : `<p class="muted-text">No photos uploaded yet.</p>`
          }
        </div>
      </section>

      <section class="authenticity-content-grid">
        <article class="authenticity-block">
          <h2>Title</h2>
          <p class="authenticity-text">${escapeHtml(displayTitle || "No title added yet.")}</p>
        </article>
        <article class="authenticity-block">
          <h2>Description</h2>
          <p class="authenticity-text authenticity-description">${escapeHtml(detail.description || "No description added yet.")}</p>
        </article>
        <article class="authenticity-block">
          <h2>Price</h2>
          <p class="authenticity-price">${escapeHtml(displayPrice)}</p>
        </article>
      </section>
    </section>
  `;

  app.append(main);
  bindImagePreviewEvents();
}

function buildTable(rows) {
  const wrapper = document.createElement("div");
  wrapper.className = "table-wrapper";

  const table = document.createElement("table");
  table.className = "dashboard-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  DASHBOARD_COLUMNS.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = column.label;
    if (column.sticky) {
      th.classList.add("sticky-column");
    }
    headerRow.append(th);
  });
  thead.append(headerRow);

  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.dataset.rowId = row.id;

    DASHBOARD_COLUMNS.forEach((column) => {
      const td = document.createElement("td");
      if (column.sticky) {
        td.classList.add("sticky-column");
      }
      if (column.wide) {
        td.classList.add("wide-cell");
      }

      if (column.key === "boxId") {
        td.innerHTML = `
          <div class="boxid-cell">
            <a data-route class="boxid-link" href="${appPath(`/${encodeURIComponent(row.boxId)}`)}">${escapeHtml(row.boxId)}</a>
            <input
              data-row-field="boxId"
              data-row-id="${row.id}"
              value="${escapeAttribute(row.boxId)}"
              type="text"
            />
          </div>
        `;
      } else if (column.key === "itemName") {
        td.innerHTML = `
          <div class="item-cell">
            <a data-route class="item-link" href="${appPath(`/${encodeURIComponent(row.boxId)}`)}">${escapeHtml(row.itemName || "Open product page")}</a>
            <input
              data-row-field="itemName"
              data-row-id="${row.id}"
              value="${escapeAttribute(row.itemName)}"
              type="text"
            />
            <div class="row-actions">
              <button
                class="button-link delete-row-button"
                type="button"
                data-delete-row="${row.id}"
              >
                Delete Row
              </button>
            </div>
          </div>
        `;
      } else if (column.type === "checkbox") {
        td.innerHTML = `
          <label class="checkbox-wrap">
            <input
              data-row-field="${column.key}"
              data-row-id="${row.id}"
              type="checkbox"
              ${row[column.key] ? "checked" : ""}
            />
            <span>${row[column.key] ? "TRUE" : "FALSE"}</span>
          </label>
        `;
      } else {
        td.innerHTML = `
          <input
            data-row-field="${column.key}"
            data-row-id="${row.id}"
            value="${escapeAttribute(row[column.key] || "")}"
            type="text"
          />
        `;
      }

      tr.append(td);
    });

    tbody.append(tr);
  });

  table.append(thead, tbody);
  wrapper.append(table);
  return wrapper;
}

function bindDashboardEvents() {
  const csvInput = document.querySelector("#csv-input");
  const addRowButton = document.querySelector("#add-row-button");
  const searchInput = document.querySelector("#search-input");
  const exportButton = document.querySelector("#export-button");
  const archiveFilter = document.querySelector("#archive-filter");
  const boxSort = document.querySelector("#box-sort");
  const signOutButton = document.querySelector("#sign-out-button");

  signOutButton?.addEventListener("click", () => {
    handleSignOut();
  });

  csvInput?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const password = window.prompt("Enter import password");
    if (password !== IMPORT_PASSWORD) {
      event.target.value = "";
      setSaveMessage("CSV import canceled. Password was not accepted.");
      render();
      return;
    }

    try {
      const text = await file.text();
      const importedRows = rowsFromCsv(text);
      const mergedImport = mergeImportedRows(importedRows);
      state.rows = mergedImport.rows;
      state.productDetails = mergedImport.productDetails;
      state.meta = {
        ...state.meta,
        lastImportAt: new Date().toISOString(),
        lastImportName: file.name,
      };

      await saveAppState({ rows: state.rows, productDetails: state.productDetails, meta: state.meta });
      setSaveMessage(`Imported ${importedRows.length} row(s) from ${file.name}.`);
      render();
    } finally {
      event.target.value = "";
    }
  });

  addRowButton?.addEventListener("click", async () => {
    state.rows = [createEmptyRow(state.rows), ...state.rows];
    await saveRows(state.rows);
    setSaveMessage("New row added.");
    render();
  });

  searchInput?.addEventListener("input", (event) => {
    state.search = event.target.value;
    render();
    window.requestAnimationFrame(() => {
      const refreshed = document.querySelector("#search-input");
      if (!refreshed) {
        return;
      }

      refreshed.focus();
      refreshed.setSelectionRange(state.search.length, state.search.length);
    });
  });

  archiveFilter?.addEventListener("change", (event) => {
    state.archiveFilter = event.target.value;
    render();
  });

  boxSort?.addEventListener("change", (event) => {
    state.boxSort = event.target.value;
    render();
  });

  exportButton?.addEventListener("click", () => {
    const password = window.prompt("Enter export password");
    if (password !== IMPORT_PASSWORD) {
      setSaveMessage("CSV export canceled. Password was not accepted.");
      render();
      return;
    }

    const csv = serializeRowsToCsv(state.rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "seller-dashboard-export.csv";
    link.click();
    URL.revokeObjectURL(url);
    setSaveMessage("Current dashboard exported as CSV.");
    render();
  });

  document.querySelectorAll("[data-row-field]").forEach((input) => {
    const eventName = input.type === "checkbox" ? "change" : "change";
    input.addEventListener(eventName, async (event) => {
      const rowId = event.target.dataset.rowId;
      const field = event.target.dataset.rowField;
      const row = state.rows.find((entry) => entry.id === rowId);

      if (!row) {
        return;
      }

      const nextValue = event.target.type === "checkbox" ? event.target.checked : event.target.value;
      const previousBoxId = row.boxId;

      if (field === "boxId") {
        row.boxId = ensureUniqueBoxId(nextValue, state.rows, row.id);
      } else {
        row[field] = nextValue;
      }

      if (field === "itemName" && (!row.boxId || row.boxId.startsWith("UNKNOWN"))) {
        const derived = extractLeadingBoxId(nextValue);
        if (derived) {
          row.boxId = ensureUniqueBoxId(derived, state.rows, row.id);
        }
      }

      if (previousBoxId !== row.boxId) {
        moveProductDetails(previousBoxId, row.boxId);
      }

      Object.assign(row, normalizeRowState(row));
      state.rows = pruneRows(state.rows.map(normalizeRowState));
      await saveAppState({ rows: state.rows, productDetails: state.productDetails });
      setSaveMessage(`Saved changes for ${row.boxId}.`);
      render();
    });
  });

  document.querySelectorAll("[data-delete-row]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const rowId = event.currentTarget.dataset.deleteRow;
      const row = state.rows.find((entry) => entry.id === rowId);

      if (!row) {
        return;
      }

      const confirmed = window.confirm(
        `Delete row ${row.boxId}${row.itemName ? ` - ${row.itemName}` : ""}? This removes it from the dashboard.`,
      );

      if (!confirmed) {
        return;
      }

      state.rows = state.rows.filter((entry) => entry.id !== rowId);
      if (row.boxId && state.productDetails[row.boxId]) {
        delete state.productDetails[row.boxId];
      }

      await saveAppState({ rows: state.rows, productDetails: state.productDetails });
      setSaveMessage(`Deleted ${row.boxId}.`);
      render();
    });
  });
}

function bindDetailEvents(boxId) {
  document.querySelector("#detail-hidden")?.addEventListener("change", async (event) => {
    const row = state.rows.find((entry) => entry.boxId === boxId);
    if (!row) {
      return;
    }

    row.hidden = event.target.checked;
    await saveRows(state.rows);
    setSaveMessage(`${row.hidden ? "Hid" : "Unhid"} ${boxId} from public view.`);
    render();
  });

  document.querySelector("#save-detail-button")?.addEventListener("click", async () => {
    const current = collectDetailDraft(boxId);
    current.updatedAt = new Date().toISOString();
    state.productDetails[boxId] = current;
    await saveProductDetails(state.productDetails);
    render();
  });

  document.querySelector("#image-input")?.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }

    const existingCount = (state.productDetails[boxId]?.images || []).length;
    const remainingSlots = Math.max(0, MAX_IMAGES_PER_PRODUCT - existingCount);
    if (remainingSlots <= 0) {
      event.target.value = "";
      setSaveMessage(`Maximum of ${MAX_IMAGES_PER_PRODUCT} images reached for ${boxId}.`);
      render();
      return;
    }

    const nextFiles = files.slice(0, remainingSlots);
    const uploaded = await uploadImages(boxId, nextFiles);

    // Re-read the draft AFTER the upload finishes. Capturing it before `await` let a slow
    // upload clobber any edits made in the meantime (typed title, a second upload, etc.),
    // which showed up as "didn't save". collectDetailDraft() now reflects the latest images
    // plus whatever is currently typed in the title/description fields.
    const draft = collectDetailDraft(boxId);
    draft.images = draft.images.concat(uploaded);
    draft.updatedAt = new Date().toISOString();
    state.productDetails[boxId] = draft;
    await saveProductDetails(state.productDetails);
    event.target.value = "";
    render();
  });

  document.querySelectorAll("[data-remove-image]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const index = Number(event.currentTarget.dataset.removeImage);
      const current = collectDetailDraft(boxId);
      current.images = current.images.filter((_, imageIndex) => imageIndex !== index);
      current.updatedAt = new Date().toISOString();
      state.productDetails[boxId] = current;
      await saveProductDetails(state.productDetails);
      render();
    });
  });

  let draggingIndex = null;
  document.querySelectorAll("[data-drag-image]").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      draggingIndex = Number(event.currentTarget.dataset.dragImage);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(draggingIndex));
      event.currentTarget.classList.add("is-dragging");
    });

    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      event.currentTarget.classList.add("is-drag-target");
    });

    card.addEventListener("dragleave", (event) => {
      event.currentTarget.classList.remove("is-drag-target");
    });

    card.addEventListener("dragend", (event) => {
      draggingIndex = null;
      event.currentTarget.classList.remove("is-dragging");
      document.querySelectorAll(".is-drag-target").forEach((element) => element.classList.remove("is-drag-target"));
    });

    card.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.currentTarget.classList.remove("is-drag-target");

      const targetIndex = Number(event.currentTarget.dataset.dragImage);
      if (!Number.isInteger(draggingIndex) || draggingIndex === targetIndex) {
        return;
      }

      const current = collectDetailDraft(boxId);
      const reordered = [...current.images];
      const [selected] = reordered.splice(draggingIndex, 1);
      reordered.splice(targetIndex, 0, selected);
      current.images = reordered;
      current.updatedAt = new Date().toISOString();
      state.productDetails[boxId] = current;
      await saveProductDetails(state.productDetails);
      render();
    });
  });
}

function bindImagePreviewEvents() {
  const previewButtons = Array.from(document.querySelectorAll("[data-preview-image]"));
  previewButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      openImageLightbox(
        previewButtons.map((element) => ({
          src: element.dataset.previewImage,
          name: element.dataset.previewName,
        })),
        Number(button.dataset.previewIndex || 0),
      );
    });
  });
}

function openImageLightbox(items, initialIndex = 0) {
  if (!Array.isArray(items) || !items.length) {
    return;
  }

  closeImageLightbox();
  const safeIndex = Math.max(0, Math.min(initialIndex, items.length - 1));
  const currentItem = items[safeIndex] || items[0];
  const overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  overlay.innerHTML = `
    <div class="image-lightbox-backdrop" data-close-lightbox></div>
    <div class="image-lightbox-dialog" role="dialog" aria-modal="true" aria-label="${escapeAttribute(currentItem.name || "Preview")}">
      <button class="image-lightbox-close" type="button" data-close-lightbox aria-label="Close image preview">Close</button>
      <button class="image-lightbox-nav prev" type="button" data-lightbox-nav="-1" aria-label="Previous image">‹</button>
      <img class="image-lightbox-photo" src="${escapeAttribute(currentItem.src || "")}" alt="${escapeAttribute(currentItem.name || "Preview")}" />
      <button class="image-lightbox-nav next" type="button" data-lightbox-nav="1" aria-label="Next image">›</button>
      <p class="image-lightbox-caption">${escapeHtml(currentItem.name || "")}</p>
    </div>
  `;

  overlay.querySelectorAll("[data-close-lightbox]").forEach((element) => {
    element.addEventListener("click", closeImageLightbox);
  });

  const photo = overlay.querySelector(".image-lightbox-photo");
  const caption = overlay.querySelector(".image-lightbox-caption");
  const dialog = overlay.querySelector(".image-lightbox-dialog");
  let currentIndex = safeIndex;

  function renderCurrent() {
    const item = items[currentIndex];
    if (!item) {
      return;
    }

    photo.src = item.src || "";
    photo.alt = item.name || "Preview";
    caption.textContent = item.name || "";
    dialog.setAttribute("aria-label", item.name || "Preview");
  }

  function move(step) {
    if (!items.length) {
      return;
    }

    currentIndex = (currentIndex + step + items.length) % items.length;
    renderCurrent();
  }

  overlay.querySelectorAll("[data-lightbox-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      move(Number(button.dataset.lightboxNav || 0));
    });
  });

  document.body.append(overlay);
  window.addEventListener("keydown", handleLightboxKeydown);

  function handleLightboxKeydown(event) {
    if (event.key === "Escape") {
      closeImageLightbox();
      return;
    }

    if (event.key === "ArrowLeft") {
      move(-1);
      return;
    }

    if (event.key === "ArrowRight") {
      move(1);
    }
  }

  overlay.dataset.keyHandlerAttached = "true";
  overlay._handleLightboxKeydown = handleLightboxKeydown;
}

function closeImageLightbox() {
  const overlay = document.querySelector(".image-lightbox");
  if (!overlay) {
    return;
  }

  if (overlay._handleLightboxKeydown) {
    window.removeEventListener("keydown", overlay._handleLightboxKeydown);
  }

  overlay.remove();
}

function createEmptyDetail(boxId) {
  return {
    boxId,
    title: "",
    description: "",
    images: [],
    updatedAt: "",
  };
}

function collectDetailDraft(boxId) {
  const current = state.productDetails[boxId] || createEmptyDetail(boxId);
  const titleInput = document.querySelector("#detail-title");
  const descriptionInput = document.querySelector("#detail-description");

  return {
    ...current,
    title: titleInput ? titleInput.value.trim() : current.title,
    description: descriptionInput ? descriptionInput.value.trim() : current.description,
  };
}

function mergeImportedRows(importedRows) {
  const nextRows = pruneRows(importedRows.map(normalizeRowState));
  const previousRowsByBoxId = new Map(
    state.rows
      .filter((row) => row?.boxId)
      .map((row) => [String(row.boxId).toUpperCase(), row]),
  );
  const nextDetails = { ...state.productDetails };

  nextRows.forEach((row) => {
    const boxId = String(row.boxId || "").toUpperCase();
    if (!boxId || !nextDetails[boxId]) {
      return;
    }

    const previousRow = previousRowsByBoxId.get(boxId);
    if (!previousRow) {
      return;
    }

    const detail = nextDetails[boxId];
    if (shouldRefreshImportedTitle(detail.title, previousRow.itemName, row.itemName)) {
      nextDetails[boxId] = {
        ...detail,
        title: row.itemName || "",
      };
    }
  });

  return {
    rows: nextRows,
    productDetails: nextDetails,
  };
}

function shouldRefreshImportedTitle(currentTitle, previousItemName, nextItemName) {
  const current = normalizeComparableTitle(currentTitle);
  const previous = normalizeComparableTitle(previousItemName);
  const next = normalizeComparableTitle(nextItemName);

  if (!next) {
    return false;
  }

  if (!current) {
    return true;
  }

  return current === previous;
}

function normalizeComparableTitle(value) {
  return String(value || "")
    .trim()
    .replace(/^\d+\s*[-:.)#]*(\s*)?/, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function buildSummary(rows) {
  return rows.reduce(
    (summary, row) => {
      summary.totalRows += 1;
      if (row.archived) {
        summary.archivedRows += 1;
      } else {
        summary.presentRows += 1;
      }

      summary.totalListedValue += parseCurrency(row.priceListed);
      return summary;
    },
    { totalRows: 0, presentRows: 0, archivedRows: 0, totalListedValue: 0 },
  );
}

function parseCurrency(value) {
  const number = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function compareBoxIds(left, right, direction = "asc") {
  const leftMeta = getBoxSortMeta(left);
  const rightMeta = getBoxSortMeta(right);

  let result = 0;
  if (leftMeta.kind !== rightMeta.kind) {
    result = leftMeta.kind === "number" ? -1 : 1;
  } else if (leftMeta.kind === "number") {
    result = leftMeta.number - rightMeta.number;
    if (result === 0) {
      result = compareText(leftMeta.raw, rightMeta.raw);
    }
  } else {
    result = compareText(leftMeta.raw, rightMeta.raw);
  }

  return direction === "desc" ? result * -1 : result;
}

function getBoxSortMeta(value) {
  const raw = String(value || "").trim().toUpperCase();
  const numericMatch = raw.match(/^(\d+)$/);

  if (numericMatch) {
    return {
      kind: "number",
      number: Number(numericMatch[1]),
      raw,
    };
  }

  return {
    kind: "text",
    number: Number.POSITIVE_INFINITY,
    raw,
  };
}

function compareText(left, right) {
  if (left === right) {
    return 0;
  }

  const leftNumber = extractLeadingNumber(left);
  const rightNumber = extractLeadingNumber(right);

  if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  return left < right ? -1 : 1;
}

function extractLeadingNumber(value) {
  const match = String(value || "").match(/^([A-Z]+)?(\d+)$/);
  if (!match) {
    return null;
  }

  return Number(match[2]);
}

function stripBoxIdPrefix(title, boxId) {
  const normalizedTitle = String(title || "").trim();
  const normalizedBoxId = String(boxId || "").trim();

  if (!normalizedTitle || !normalizedBoxId) {
    return normalizedTitle;
  }

  const pattern = new RegExp(`^${escapeRegExp(normalizedBoxId)}(?:\\b|\\s*[-:)#.(]\\s*)`, "i");
  return normalizedTitle.replace(pattern, "").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function navigate(path) {
  const nextPath = appPath(path);

  if (window.location.pathname === nextPath) {
    return;
  }

  window.history.pushState({}, "", nextPath);
  render();
}

function getCurrentRoute() {
  const path = stripBasePath(decodeURIComponent(window.location.pathname));
  const parts = path.split("/").filter(Boolean);

  if (parts[0] === "health") {
    return {
      page: "health",
      boxId: "",
      subpage: "",
    };
  }

  const catalogKey = (parts[0] || "").toLowerCase();
  if (CATALOGS[catalogKey] && !parts[1]) {
    return {
      page: "catalog",
      catalog: catalogKey,
      boxId: "",
      subpage: "",
    };
  }

  return {
    page: "",
    boxId: parts[0] || "",
    subpage: parts[1] || "",
  };
}

function setSaveMessage(message) {
  state.saveMessage = message;
}

function moveProductDetails(previousBoxId, nextBoxId) {
  if (!previousBoxId || previousBoxId === nextBoxId) {
    return;
  }

  const existing = state.productDetails[previousBoxId];
  if (!existing) {
    return;
  }

  state.productDetails[nextBoxId] = { ...existing, boxId: nextBoxId };
  delete state.productDetails[previousBoxId];
}

function buildSnapshotRow(label, value) {
  return `
    <div class="snapshot-item">
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value || "—")}</dd>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function getImageSource(image) {
  const url = image?.url || image?.dataUrl || "";
  if (!url.startsWith("/")) {
    return url;
  }

  if (url.startsWith("/uploads/") && BASE_PATH) {
    return `${BASE_PATH}${url}`;
  }

  return url;
}

function normalizeBasePath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function appPath(path = "/") {
  const normalized = String(path || "/");
  if (BASE_PATH && (normalized === BASE_PATH || normalized.startsWith(`${BASE_PATH}/`))) {
    return normalized;
  }

  if (!normalized || normalized === "/") {
    return BASE_PATH ? `${BASE_PATH}/` : "/";
  }

  return `${BASE_PATH}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

function stripBasePath(pathname) {
  if (!BASE_PATH) {
    return pathname || "/";
  }

  if (pathname === BASE_PATH) {
    return "/";
  }

  if (pathname.startsWith(`${BASE_PATH}/`)) {
    return pathname.slice(BASE_PATH.length) || "/";
  }

  return pathname || "/";
}

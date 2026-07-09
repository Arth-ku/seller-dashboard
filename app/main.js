import {
  COLUMN_DEFS,
  createEmptyRow,
  ensureUniqueBoxId,
  extractLeadingBoxId,
  normalizeRowState,
  pruneRows,
} from "./csv.js?v=20260709g";
import {
  fetchSession,
  loadAppState,
  loadHistorySnapshots,
  loadHistoryState,
  loadHealth,
  login,
  logout,
  refreshGoogleSheet,
  saveAppState,
  saveProductDetails,
  saveRows,
  uploadImages,
} from "./store.js?v=20260709g";

const app = document.querySelector("#app");
const APP_CONFIG = window.__APP_CONFIG__ || {};
const BASE_PATH = normalizeBasePath(APP_CONFIG.basePath);
const DASHBOARD_COLUMNS = COLUMN_DEFS.filter(({ key }) =>
  ["boxId", "archived", "hidden", "itemName"].includes(key),
);
const MAX_IMAGES_PER_PRODUCT = 30;
const HEALTH_REFRESH_MS = 15000;
const STALE_LISTING_DAYS = 150;

// Admin category views. These pages show every matching item, including hidden ones.
// Public catalog pages on authenticitycheck.net remain separate for HVAC/Apparel.
const CATALOGS = {
  units: {
    label: "Units",
    from: 1,
    to: 999,
    ranges: [
      [1, 699],
      [800, 999],
    ],
    rangeLabel: "1-699, 800-999 plus UNKNOWN",
    includeUnknown: true,
    description: "General inventory units, plus older UNKNOWN rows without a numeric Box ID.",
  },
  hvac: {
    label: "HVAC",
    from: 700,
    to: 800,
    rangeLabel: "700-800",
    description: "HVAC systems, AC units, dehumidifiers, and related equipment.",
    publicPath: "/hvac",
  },
  apparel: {
    label: "Apparel",
    from: 1000,
    to: 1100,
    rangeLabel: "1000-1100",
    description: "Designer and apparel inventory.",
    publicPath: "/apparel",
  },
};
const CATEGORY_ORDER = ["units", "hvac", "apparel"];

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
  historySnapshots: [],
  viewingSnapshot: null,
  salesPeriodMode: "all",
  salesPeriodYear: new Date().getFullYear(),
  salesPeriodMonth: new Date().getMonth() + 1,
  salesPeriodWeek: "",
  saveToast: null,
  isRefreshingSheet: false,
  adminSearchQuery: "",
};
let healthRefreshTimer = null;
let saveToastTimer = null;
let adminSearchTimer = null;

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
    state.viewingSnapshot = null;
    state.historySnapshots = await loadHistorySnapshots();

    if ((stored.rows || []).length !== state.rows.length) {
      await saveRows(state.rows);
      state.historySnapshots = await loadHistorySnapshots();
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

async function loadSnapshotAndRender(snapshotId) {
  try {
    const stored = await loadHistoryState(snapshotId);
    state.rows = pruneRows((stored.rows || []).map(normalizeRowState));
    state.productDetails =
      stored.productDetails && typeof stored.productDetails === "object" ? stored.productDetails : {};
    state.meta = stored.meta && typeof stored.meta === "object" ? stored.meta : {};
    state.viewingSnapshot = stored.snapshot || null;
    setSaveMessage(
      state.viewingSnapshot
        ? `Viewing saved dashboard from ${formatDateTime(state.viewingSnapshot.createdAt)}.`
        : "Viewing saved dashboard history.",
    );
    render();
  } catch (error) {
    setSaveMessage(error?.message || "Could not load selected dashboard history.");
    render();
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
  app.dataset.rendered = "true";
  app.innerHTML = "";
  clearHealthRefresh();

  if (route.page === "health") {
    renderHealthPage();
  } else if (route.page === "health-rank") {
    renderHealthRankPage();
  } else if (route.page === "catalog") {
    renderCatalogPage(route.catalog);
  } else if (route.subpage === "authenticity" && route.boxId) {
    renderAuthenticityPage(route.boxId);
  } else if (route.boxId) {
    renderProductDetail(route.boxId);
  } else {
    renderDashboard();
  }

  renderSaveToast();
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

function renderHealthRankPage() {
  const rows = pruneRows((Array.isArray(state.rows) ? state.rows : []).map(normalizeRowState));
  const ranked = rows
    .filter((row) => !row.archived)
    .map((row) => ({
      ...scoreLiveItem(row),
      categoryLabel: getCatalogLabelsForRow(row).join(" / ") || "Uncategorized",
    }))
    .sort((left, right) => right.score - left.score || compareBoxIds(left.row.boxId, right.row.boxId, "asc"));
  const badCount = ranked.filter((entry) => entry.severity === "bad").length;
  const warnCount = ranked.filter((entry) => entry.severity === "warn").length;
  const okCount = ranked.length - badCount - warnCount;

  const main = document.createElement("main");
  main.className = "shell";
  main.innerHTML = `
    <section class="panel detail-panel">
      <div class="detail-header">
        <div>
          <a class="back-link" data-route href="${appPath("/")}">Back to dashboard</a>
          <p class="eyebrow">Active Inventory</p>
          <h1>Unit health rank</h1>
          <p class="detail-subtitle">Every live item ranked by business urgency: stale age, missing price/photos/content, weak tracking, and ad signals.</p>
        </div>
        <div class="detail-meta">
          <span class="detail-pill">${ranked.length} live</span>
          <span class="detail-pill pill-hidden">${badCount} critical</span>
          <span class="detail-pill">${warnCount} watch</span>
          <span class="detail-pill pill-public">${okCount} healthy</span>
        </div>
      </div>

      <div class="health-rank-table">
        <div class="health-rank-header">
          <span>Score</span>
          <span>Item</span>
          <span>Category</span>
          <span>Age</span>
          <span>Advice</span>
        </div>
        ${
          ranked.length
            ? ranked.map(fullHealthRankRow).join("")
            : `<div class="empty-state compact-empty"><h2>No live items</h2></div>`
        }
      </div>
    </section>
  `;

  app.append(main);
}

function fullHealthRankRow(entry) {
  return `
    <article class="health-rank-row severity-${escapeAttribute(entry.severity)}">
      <div class="rank-score">${entry.score}</div>
      <div>
        <a class="boxid-link" data-route href="${appPath(`/${encodeURIComponent(entry.row.boxId)}`)}">${escapeHtml(entry.row.boxId)}</a>
        <strong>${escapeHtml(entry.title)}</strong>
        <div class="rank-tags">
          ${entry.reasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
        </div>
      </div>
      <div>${escapeHtml(entry.categoryLabel)}</div>
      <div>${entry.ageDays == null ? "No date" : `${entry.ageDays} days`}</div>
      <div>${escapeHtml(entry.primaryAdvice)}</div>
    </article>
  `;
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
  const historyMode = isHistoryMode();
  const items = (Array.isArray(state.rows) ? state.rows : [])
    .filter((row) => rowBelongsToCatalog(row, catalog))
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
  const archivedCount = items.filter((row) => row.archived).length;
  const presentCount = items.length - archivedCount;
  const liveItems = items.filter((row) => !row.archived);
  const archivedItems = items.filter((row) => row.archived);

  const main = document.createElement("main");
  main.className = "shell";
  main.innerHTML = `
    <section class="panel detail-panel">
      <div class="detail-header">
        <div>
          <a class="back-link" data-route href="${appPath("/")}">Back to dashboard</a>
          <p class="eyebrow">Inventory Category</p>
          <h1>${escapeHtml(catalog.label)}</h1>
          <p class="detail-subtitle">Box IDs ${escapeHtml(catalog.rangeLabel || `${catalog.from}-${catalog.to}`)}. ${escapeHtml(catalog.description || "Shows every matching item including hidden ones.")}</p>
        </div>
        <div class="detail-meta">
          <span class="detail-pill">${items.length} item${items.length === 1 ? "" : "s"}</span>
          <span class="detail-pill">${presentCount} present</span>
          <span class="detail-pill">${archivedCount} archived</span>
          <span class="detail-pill ${hiddenCount ? "pill-hidden" : "pill-public"}">${hiddenCount} hidden</span>
          ${catalog.publicPath ? `<a class="detail-pill pill-link" href="${escapeAttribute(catalog.publicPath)}" target="_blank" rel="noopener">Open public page ↗</a>` : ""}
        </div>
      </div>

      ${renderCatalogAnalytics(items)}

      <div class="catalog-toolbar">
        <label class="search-field">
          <span>Search ${escapeHtml(catalog.label)}</span>
          <input id="catalog-search" type="search" value="${escapeAttribute(state.catalogSearch)}" placeholder="Box ID, name, price..." />
        </label>
        <button id="catalog-add" class="button primary" type="button" ${historyMode ? "disabled" : ""}>Add ${escapeHtml(catalog.label)} item</button>
      </div>

      ${
        items.length
          ? `${renderBusinessPriorityBoard(items)}
             ${renderCatalogSection("Present / active listings", liveItems, "Items currently for sale. Work these before looking at sold history.", "present")}
             ${renderCatalogSection("Archived / sold history", archivedItems, "Sold items kept for channel, price, speed, and ad analysis.", "archived")}`
          : `<div class="empty-state"><h2>No items in this range yet</h2><p>Items matching ${escapeHtml(catalog.rangeLabel || `${catalog.from}-${catalog.to}`)} will appear here.</p></div>`
      }
    </section>
  `;

  app.append(main);
  bindCatalogEvents(catalogName);
}

function renderCatalogSection(title, rows, description, kind) {
  const rowsWithPhotos = rows.filter(rowHasCatalogImage);
  const rowsWithoutPhotos = rows.filter((row) => !rowHasCatalogImage(row));
  return `
    <section class="catalog-section catalog-section-${escapeAttribute(kind)}">
      <div class="catalog-section-heading">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(description)}</p>
        </div>
        <span class="detail-pill">${rows.length} item${rows.length === 1 ? "" : "s"}</span>
      </div>
      ${
        rows.length
          ? `${rowsWithPhotos.length ? `<div class="catalog-grid">${rowsWithPhotos.map(catalogCard).join("")}</div>` : ""}
             ${
               rowsWithoutPhotos.length
                 ? `<div class="catalog-list-panel">
                      <div class="catalog-list-heading">
                        <h3>No-photo items</h3>
                        <span>${rowsWithoutPhotos.length} item${rowsWithoutPhotos.length === 1 ? "" : "s"}</span>
                      </div>
                      <div class="catalog-list">${rowsWithoutPhotos.map(catalogListItem).join("")}</div>
                    </div>`
                 : ""
             }`
          : `<div class="empty-state compact-empty"><h2>No ${escapeHtml(title.toLowerCase())}</h2></div>`
      }
    </section>
  `;
}

function rowHasCatalogImage(row) {
  const detail = state.productDetails[row.boxId] || {};
  return Array.isArray(detail.images) && detail.images.length > 0;
}

function catalogCard(row) {
  const historyMode = isHistoryMode();
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
            <input type="checkbox" data-catalog-hidden="${escapeAttribute(row.boxId)}" ${row.hidden ? "checked" : ""} ${historyMode ? "disabled" : ""} />
            <span>${row.hidden ? "Hidden" : "Public"}</span>
          </label>
          <a class="button-link" data-route href="${productHref}">Edit</a>
        </div>
      </div>
    </article>
  `;
}

function catalogListItem(row) {
  const historyMode = isHistoryMode();
  const detail = state.productDetails[row.boxId] || createEmptyDetail(row.boxId);
  const title =
    stripBoxIdPrefix(detail.title, row.boxId) ||
    stripBoxIdPrefix(row.itemName || "", row.boxId) ||
    "Untitled item";
  const price = (row.revised || "").trim() || (row.priceListed || "").trim() || "No price";
  const productHref = appPath(`/${encodeURIComponent(row.boxId)}`);

  return `
    <article class="catalog-list-item ${row.hidden ? "is-hidden-item" : ""}">
      <div class="catalog-list-id">
        <a class="boxid-link" data-route href="${productHref}">${escapeHtml(row.boxId || "UNKNOWN")}</a>
        ${row.archived ? `<span class="detail-pill">Archived</span>` : ""}
      </div>
      <div class="catalog-list-main">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(price)}</span>
      </div>
      <div class="catalog-list-actions">
        <label class="checkbox-wrap">
          <input type="checkbox" data-catalog-hidden="${escapeAttribute(row.boxId)}" ${row.hidden ? "checked" : ""} ${historyMode ? "disabled" : ""} />
          <span>${row.hidden ? "Hidden" : "Public"}</span>
        </label>
        <a class="button-link" data-route href="${productHref}">Edit</a>
      </div>
    </article>
  `;
}

function bindCatalogEvents(catalogName) {
  const catalog = CATALOGS[catalogName];

  document.querySelector("#catalog-add")?.addEventListener("click", async () => {
    if (isHistoryMode()) {
      setSaveMessage("Return to current before adding catalog items.");
      render();
      return;
    }

    const nextId = getNextAvailableBoxId(catalog, state.rows);

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
    state.historySnapshots = await loadHistorySnapshots();
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

  document.querySelector("#sales-period-mode")?.addEventListener("change", (event) => {
    state.salesPeriodMode = event.target.value;
    render();
  });

  document.querySelector("#sales-period-year")?.addEventListener("change", (event) => {
    state.salesPeriodYear = Number(event.target.value) || new Date().getFullYear();
    render();
  });

  document.querySelector("#sales-period-month")?.addEventListener("change", (event) => {
    state.salesPeriodMonth = Number(event.target.value) || new Date().getMonth() + 1;
    state.salesPeriodWeek = "";
    render();
  });

  document.querySelector("#sales-period-week")?.addEventListener("change", (event) => {
    state.salesPeriodWeek = event.target.value;
    render();
  });

  document.querySelectorAll("[data-catalog-hidden]").forEach((input) => {
    input.addEventListener("change", async (event) => {
      const boxId = event.target.dataset.catalogHidden;
      if (isHistoryMode()) {
        setSaveMessage("Historical snapshots are read-only.");
        render();
        return;
      }

      const row = state.rows.find((entry) => entry.boxId === boxId);
      if (!row) {
        return;
      }
      row.hidden = event.target.checked;
      await saveRows(state.rows);
      state.historySnapshots = await loadHistorySnapshots();
      setSaveMessage(`${row.hidden ? "Hid" : "Unhid"} ${boxId} from public view.`);
      render();
    });
  });
}

function renderDashboard() {
  const main = document.createElement("main");
  main.className = "shell";

  const historyMode = isHistoryMode();
  const rows = pruneRows((Array.isArray(state.rows) ? state.rows : []).map(normalizeRowState));
  const summary = buildSummary(rows);
  const categorySummaries = CATEGORY_ORDER.map((key) => buildCategorySummary(key, rows));
  const categorizedIds = new Set(categorySummaries.flatMap((entry) => entry.rows.map((row) => row.id)));
  const uncategorizedCount = rows.filter((row) => !categorizedIds.has(row.id)).length;
  const lastImport = state.meta.lastImportAt
    ? new Date(state.meta.lastImportAt).toLocaleString()
    : "No CSV imported yet";
  const selectedHistoryValue = historyMode ? String(state.viewingSnapshot.id) : "current";

  main.innerHTML = `
    ${
      historyMode
        ? `<section class="history-banner">
            <strong>Historical view</strong>
            <span>Showing ${escapeHtml(formatDateTime(state.viewingSnapshot.createdAt))}. Editing is disabled until you return to current.</span>
            <button id="history-current-button" class="button secondary" type="button">Back to current</button>
          </section>`
        : ""
    }

    ${renderAdminSearchPanel()}

    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Seller Dashboard</p>
        <h1>Track inventory, pricing, sales, and box details in one place.</h1>
        <p class="hero-text">
          Refresh from the Google Sheet, edit rows directly on the site, and open any product page
          to manage photos, title, and description.
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
          <button id="refresh-sheet-button" class="button primary" type="button" ${historyMode || state.isRefreshingSheet ? "disabled" : ""}>
            ${state.isRefreshingSheet ? "Refreshing..." : "Refresh now"}
          </button>
          <a class="button ghost" data-route href="${appPath("/health-rank")}">Unit Health</a>
          <a class="button ghost" data-route href="${appPath("/units")}">Units</a>
          <a class="button ghost" data-route href="${appPath("/hvac")}">HVAC</a>
          <a class="button ghost" data-route href="${appPath("/apparel")}">Apparel</a>
          <a class="button ghost" data-route href="${appPath("/health")}">Health</a>
          ${state.session.authRequired ? `<button id="sign-out-button" class="button ghost" type="button">Sign out</button>` : ""}
        </div>
        <div class="toolbar-filters">
          <label class="search-field history-field">
            <span>Playback</span>
            <select id="history-select">
              <option value="current" ${selectedHistoryValue === "current" ? "selected" : ""}>Current live dashboard</option>
              ${state.historySnapshots
                .map(
                  (snapshot) => `
                    <option value="${escapeAttribute(snapshot.id)}" ${selectedHistoryValue === String(snapshot.id) ? "selected" : ""}>
                      ${escapeHtml(formatSnapshotOption(snapshot))}
                    </option>
                  `,
                )
                .join("")}
            </select>
          </label>
        </div>
      </div>

      <div class="status-row">
        <p><strong>Last import:</strong> ${escapeHtml(lastImport)}</p>
        <p>${escapeHtml(state.saveMessage || (historyMode ? "Historical snapshots are read-only." : "Inline row edits save automatically on the server."))}</p>
      </div>
    </section>
  `;

  const categoryPanel = document.createElement("section");
  categoryPanel.className = "panel category-panel";
  categoryPanel.innerHTML = `
    <div class="category-panel-heading">
      <div>
        <h2>Inventory categories</h2>
        <p>Open one category at a time instead of working from one mixed list.</p>
      </div>
      ${uncategorizedCount ? `<span class="detail-pill pill-hidden">${uncategorizedCount} uncategorized</span>` : ""}
    </div>
    <div class="category-grid">
      ${categorySummaries.map(categoryCard).join("")}
    </div>
  `;

  main.append(categoryPanel);
  app.append(main);

  bindAdminSearchEvents();
  bindDashboardEvents();
}

function renderProductDetail(boxId) {
  const main = document.createElement("main");
  main.className = "shell";

  const historyMode = isHistoryMode();
  const row = state.rows.find((entry) => entry.boxId === boxId);
  const detail = state.productDetails[boxId] || createEmptyDetail(boxId);
  const imageCountText = `${detail.images.length}/${MAX_IMAGES_PER_PRODUCT} images uploaded`;

  main.innerHTML = `
    ${renderAdminSearchPanel()}

    <section class="panel detail-panel">
      ${
        historyMode
          ? `<div class="history-banner inline-history-banner">
              <strong>Historical view</strong>
              <span>Showing ${escapeHtml(formatDateTime(state.viewingSnapshot.createdAt))}. Product editing and uploads are disabled.</span>
              <button id="history-current-button" class="button secondary" type="button">Back to current</button>
            </div>`
          : ""
      }
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
        <div class="detail-header-actions">
          <button
            id="copy-download-button"
            class="icon-button"
            type="button"
            title="Copy listing text and download photos"
            aria-label="Copy listing text and download photos"
          >
            ${copyIconSvg()}
          </button>
          <div class="detail-meta">
            <span class="detail-pill">${row?.archived ? "Archived" : "Present"}</span>
            <span class="detail-pill ${row?.hidden ? "pill-hidden" : "pill-public"}">${row?.hidden ? "Hidden from public" : "Public"}</span>
            <span class="detail-pill">${escapeHtml(row?.priceListed || "No listed price")}</span>
            <span class="detail-pill">${escapeHtml(row?.soldThrough || "No sale platform")}</span>
          </div>
        </div>
      </div>

      ${
        row
          ? `<div class="visibility-bar">
              <label class="checkbox-wrap">
                <input id="detail-hidden" type="checkbox" ${row.hidden ? "checked" : ""} ${historyMode ? "disabled" : ""} />
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
              <input id="image-input" type="file" accept=".webp,.jpg,.jpeg,.png,.gif,.avif,.bmp,.svg,.heic,.heif,image/webp,image/jpeg,image/png,image/gif,image/avif,image/bmp,image/svg+xml,image/heic,image/heif" multiple ${historyMode ? "disabled" : ""} />
              <span>Upload up to ${MAX_IMAGES_PER_PRODUCT} images</span>
              <small>Photos are stored on the server so every device can see them. Supports webp, jpg, jpeg, png, gif, avif, bmp, svg, heic, and heif.</small>
            </label>
            <div class="image-grid">
              ${
                detail.images.length
                  ? detail.images
                      .map(
                        (image, index) => `
                          <figure class="image-card draggable-image-card" draggable="${historyMode ? "false" : "true"}" data-drag-image="${index}">
                            <img src="${escapeAttribute(getImageSource(image))}" alt="${escapeAttribute(image.name || `Image ${index + 1}`)}" draggable="false" />
                            <figcaption>
                              <span class="image-name">${escapeHtml(image.name || `Image ${index + 1}`)}</span>
                              <div class="image-actions">
                                ${historyMode ? "" : `<span class="drag-hint">Drag to reorder</span>`}
                                ${historyMode ? "" : `<button class="button-link" type="button" data-remove-image="${index}">Remove</button>`}
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
              <input id="detail-title" type="text" value="${escapeAttribute(detail.title)}" placeholder="Write a listing title" ${historyMode ? "disabled" : ""} />
            </label>
            <label class="field">
              <span>Description</span>
              <textarea id="detail-description" rows="10" placeholder="Write the item description" ${historyMode ? "disabled" : ""}>${escapeHtml(detail.description)}</textarea>
            </label>
            <div class="button-row">
              <button id="save-detail-button" class="button primary" type="button" ${historyMode ? "disabled" : ""}>Save Details</button>
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
  bindAdminSearchEvents();
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

function renderAdminSearchPanel() {
  const query = state.adminSearchQuery || "";
  const trimmed = query.trim();
  const exactMatch = findExactBoxId(trimmed);
  const results = trimmed && !exactMatch ? findAdminSearchResults(trimmed) : [];

  return `
    <section class="panel admin-search-panel">
      <form id="admin-search-form" class="admin-search-form">
        <label class="admin-search-field">
          <span>Find box</span>
          <input
            id="admin-search-input"
            type="search"
            autocomplete="off"
            placeholder="Box ID or title"
            value="${escapeAttribute(query)}"
          />
        </label>
        <button class="button primary" type="submit">Search</button>
        ${
          trimmed
            ? `<button id="admin-search-clear" class="button ghost" type="button">Back to list</button>`
            : `<a class="button ghost" data-route href="${appPath("/")}">Back to list</a>`
        }
      </form>
      ${
        trimmed && !exactMatch
          ? `
            <div class="admin-search-results" aria-live="polite">
              <div class="admin-search-summary">
                <strong>${results.length ? `${results.length} result${results.length === 1 ? "" : "s"}` : "No results"}</strong>
                <span>${escapeHtml(results.length ? `Matching "${trimmed}"` : `Nothing matches "${trimmed}"`)}</span>
              </div>
              ${
                results.length
                  ? `<div class="admin-search-grid">${results.map(adminSearchResultCard).join("")}</div>`
                  : `<p class="muted-text">Try a Box ID, title word, brand, or item name.</p>`
              }
            </div>
          `
          : ""
      }
    </section>
  `;
}

function adminSearchResultCard(entry) {
  const row = entry.row;
  const detail = entry.detail;
  const title = detail.title || row.itemName || "";
  const subtitle = row.itemName && row.itemName !== title ? row.itemName : detail.description || "";
  const status = row.hidden ? "Hidden" : row.archived ? "Archived" : "Present";
  const firstImage = Array.isArray(detail.images) ? detail.images.find((image) => getImageSource(image)) : null;
  const imageSource = firstImage ? getImageSource(firstImage) : "";
  return `
    <a class="admin-search-card" data-route href="${appPath(`/${encodeURIComponent(row.boxId)}`)}">
      <span class="admin-search-card-photo">
        ${
          imageSource
            ? `<img src="${escapeAttribute(imageSource)}" alt="${escapeAttribute(firstImage.name || `${row.boxId} photo`)}" loading="lazy" decoding="async" />`
            : `<span>No photo</span>`
        }
      </span>
      <span class="admin-search-card-body">
        <span class="admin-search-card-id">${escapeHtml(row.boxId)}</span>
        <span class="admin-search-card-title">${escapeHtml(title || "Untitled unit")}</span>
        <span class="admin-search-card-subtitle">${escapeHtml(subtitle || "No title or item name available.")}</span>
        <span class="admin-search-card-meta">
          <span>${escapeHtml(status)}</span>
          <span>${escapeHtml(row.revised || row.priceListed || "No price")}</span>
        </span>
      </span>
    </a>
  `;
}

function bindAdminSearchEvents() {
  const form = document.querySelector("#admin-search-form");
  const input = document.querySelector("#admin-search-input");
  const clearButton = document.querySelector("#admin-search-clear");

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = String(input?.value || "").trim();
    state.adminSearchQuery = query;
    const exactBoxId = findExactBoxId(query);
    if (exactBoxId) {
      state.adminSearchQuery = "";
      navigate(`/${encodeURIComponent(exactBoxId)}`);
      return;
    }
    render();
    focusAdminSearch();
  });

  input?.addEventListener("input", (event) => {
    state.adminSearchQuery = event.target.value;
    const query = state.adminSearchQuery.trim();
    const exactBoxId = findExactBoxId(query);
    if (adminSearchTimer) {
      window.clearTimeout(adminSearchTimer);
      adminSearchTimer = null;
    }

    if (exactBoxId && !hasLongerBoxIdStartingWith(query)) {
      adminSearchTimer = window.setTimeout(() => {
        if (state.adminSearchQuery.trim().toUpperCase() !== exactBoxId.toUpperCase()) {
          return;
        }
        state.adminSearchQuery = "";
        navigate(`/${encodeURIComponent(exactBoxId)}`);
      }, 350);
      return;
    }

    render();
    focusAdminSearch();
  });

  clearButton?.addEventListener("click", () => {
    state.adminSearchQuery = "";
    navigate("/");
    render();
  });
}

function focusAdminSearch() {
  window.requestAnimationFrame(() => {
    const refreshed = document.querySelector("#admin-search-input");
    if (!refreshed) {
      return;
    }
    refreshed.focus();
    refreshed.setSelectionRange(refreshed.value.length, refreshed.value.length);
  });
}

function findExactBoxId(query) {
  const normalized = String(query || "").trim().toUpperCase();
  if (!normalized) {
    return "";
  }
  const row = state.rows.find((entry) => String(entry.boxId || "").toUpperCase() === normalized);
  return row?.boxId || "";
}

function hasLongerBoxIdStartingWith(query) {
  const normalized = String(query || "").trim().toUpperCase();
  return state.rows.some((entry) => {
    const boxId = String(entry.boxId || "").toUpperCase();
    return boxId !== normalized && boxId.startsWith(normalized);
  });
}

function findAdminSearchResults(query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) {
    return [];
  }

  return pruneRows((Array.isArray(state.rows) ? state.rows : []).map(normalizeRowState))
    .map((row) => ({
      row,
      detail: state.productDetails[row.boxId] || createEmptyDetail(row.boxId),
    }))
    .filter(({ row, detail }) =>
      [
        row.boxId,
        row.itemName,
        row.priceListed,
        row.revised,
        row.soldThrough,
        detail.title,
        detail.description,
      ]
        .map(normalizeSearchText)
        .some((value) => value.includes(normalized)),
    )
    .sort(compareAdminSearchResults);
}

function compareAdminSearchResults(left, right) {
  if (Boolean(left.row.archived) !== Boolean(right.row.archived)) {
    return left.row.archived ? 1 : -1;
  }

  const leftNumber = Number.parseInt(left.row.boxId, 10);
  const rightNumber = Number.parseInt(right.row.boxId, 10);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }

  return String(left.row.boxId || "").localeCompare(String(right.row.boxId || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function normalizeSearchText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function buildTable(rows) {
  const historyMode = isHistoryMode();
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
              ${historyMode ? "disabled" : ""}
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
              ${historyMode ? "disabled" : ""}
            />
            <div class="row-actions ${historyMode ? "is-hidden" : ""}">
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
              ${historyMode ? "disabled" : ""}
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
            ${historyMode ? "disabled" : ""}
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
  const addRowButton = document.querySelector("#add-row-button");
  const searchInput = document.querySelector("#search-input");
  const refreshSheetButton = document.querySelector("#refresh-sheet-button");
  const archiveFilter = document.querySelector("#archive-filter");
  const boxSort = document.querySelector("#box-sort");
  const signOutButton = document.querySelector("#sign-out-button");
  const historySelect = document.querySelector("#history-select");
  const historyCurrentButton = document.querySelector("#history-current-button");

  signOutButton?.addEventListener("click", () => {
    handleSignOut();
  });

  historySelect?.addEventListener("change", async (event) => {
    const value = event.target.value;
    if (value === "current") {
      await loadAndRender();
      return;
    }
    await loadSnapshotAndRender(value);
  });

  historyCurrentButton?.addEventListener("click", async () => {
    await loadAndRender();
  });

  refreshSheetButton?.addEventListener("click", async () => {
    if (isHistoryMode()) {
      setSaveMessage("Return to current before refreshing from Google Sheet.");
      render();
      return;
    }

    state.isRefreshingSheet = true;
    setSaveMessage("Refreshing from Google Sheet now...", { kind: "saving", autoDismiss: false });
    render();
    try {
      const result = await refreshGoogleSheet();
      const stored = await loadAppState();
      state.rows = pruneRows((stored.rows || []).map(normalizeRowState));
      state.productDetails = stored.productDetails;
      state.meta = stored.meta;
      state.viewingSnapshot = null;
      state.historySnapshots = await loadHistorySnapshots();
      setSaveMessage(`Refreshed ${result.rowCount || state.rows.length} row(s) from Google Sheet.`, {
        kind: "success",
        heading: "Refreshed",
      });
    } catch (error) {
      if (error && error.unauthorized) {
        state.session = { authenticated: false, authRequired: true };
        renderLogin();
        return;
      }
      setSaveMessage(error?.message || "Could not refresh from Google Sheet.", { kind: "warning" });
    } finally {
      state.isRefreshingSheet = false;
      render();
    }
  });

  addRowButton?.addEventListener("click", async () => {
    if (isHistoryMode()) {
      setSaveMessage("Return to current before adding rows.");
      render();
      return;
    }

    state.rows = [createEmptyRow(state.rows), ...state.rows];
    await saveRows(state.rows);
    state.historySnapshots = await loadHistorySnapshots();
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

  document.querySelectorAll("[data-row-field]").forEach((input) => {
    const eventName = input.type === "checkbox" ? "change" : "change";
    input.addEventListener(eventName, async (event) => {
      const rowId = event.target.dataset.rowId;
      if (isHistoryMode()) {
        setSaveMessage("Historical snapshots are read-only.");
        render();
        return;
      }

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
      state.historySnapshots = await loadHistorySnapshots();
      setSaveMessage(`Saved changes for ${row.boxId}.`);
      render();
    });
  });

  document.querySelectorAll("[data-delete-row]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const rowId = event.currentTarget.dataset.deleteRow;
      if (isHistoryMode()) {
        setSaveMessage("Historical snapshots are read-only.");
        render();
        return;
      }

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
      state.historySnapshots = await loadHistorySnapshots();
      setSaveMessage(`Deleted ${row.boxId}.`);
      render();
    });
  });
}

function bindDetailEvents(boxId) {
  document.querySelector("#history-current-button")?.addEventListener("click", async () => {
    await loadAndRender();
  });

  document.querySelector("#copy-download-button")?.addEventListener("click", async () => {
    await copyListingAndDownloadImages(boxId);
  });

  document.querySelector("#detail-hidden")?.addEventListener("change", async (event) => {
    if (isHistoryMode()) {
      setSaveMessage("Historical snapshots are read-only.");
      render();
      return;
    }

    const row = state.rows.find((entry) => entry.boxId === boxId);
    if (!row) {
      return;
    }

    row.hidden = event.target.checked;
    await saveRows(state.rows);
    state.historySnapshots = await loadHistorySnapshots();
    setSaveMessage(`${row.hidden ? "Hid" : "Unhid"} ${boxId} from public view.`);
    render();
  });

  document.querySelector("#save-detail-button")?.addEventListener("click", async () => {
    if (isHistoryMode()) {
      setSaveMessage("Historical snapshots are read-only.");
      render();
      return;
    }

    const button = document.querySelector("#save-detail-button");
    setButtonSaving(button, true);
    try {
      const current = collectDetailDraft(boxId);
      current.updatedAt = new Date().toISOString();
      state.productDetails[boxId] = current;
      await saveProductDetails(state.productDetails);
      state.historySnapshots = await loadHistorySnapshots();
      setSaveMessage(`Saved details for ${boxId}.`, { kind: "success" });
    } catch (error) {
      setSaveMessage(error?.message || `Could not save details for ${boxId}.`, { kind: "warning" });
    } finally {
      render();
    }
  });

  document.querySelector("#image-input")?.addEventListener("change", async (event) => {
    if (isHistoryMode()) {
      event.target.value = "";
      setSaveMessage("Return to current before uploading images.");
      render();
      return;
    }

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

    try {
      const nextFiles = files.slice(0, remainingSlots);
      setSaveMessage(`Uploading ${nextFiles.length} image${nextFiles.length === 1 ? "" : "s"} for ${boxId}...`, {
        kind: "saving",
        autoDismiss: false,
      });
      renderSaveToast();
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
      state.historySnapshots = await loadHistorySnapshots();
      setSaveMessage(`Uploaded and saved ${uploaded.length} image${uploaded.length === 1 ? "" : "s"} for ${boxId}.`, {
        kind: "success",
      });
    } catch (error) {
      setSaveMessage(error?.message || `Could not upload images for ${boxId}.`, { kind: "warning" });
    } finally {
      event.target.value = "";
      render();
    }
  });

  document.querySelectorAll("[data-remove-image]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      if (isHistoryMode()) {
        setSaveMessage("Historical snapshots are read-only.");
        render();
        return;
      }

      const index = Number(event.currentTarget.dataset.removeImage);
      const current = collectDetailDraft(boxId);
      current.images = current.images.filter((_, imageIndex) => imageIndex !== index);
      current.updatedAt = new Date().toISOString();
      state.productDetails[boxId] = current;
      await saveProductDetails(state.productDetails);
      state.historySnapshots = await loadHistorySnapshots();
      setSaveMessage(`Removed photo and saved ${boxId}.`, { kind: "success" });
      render();
    });
  });

  let draggingIndex = null;
  document.querySelectorAll("[data-drag-image]").forEach((card) => {
    if (isHistoryMode()) {
      return;
    }

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
      state.historySnapshots = await loadHistorySnapshots();
      setSaveMessage(`Reordered photos and saved ${boxId}.`, { kind: "success" });
      render();
    });
  });
}

async function copyListingAndDownloadImages(boxId) {
  const detail = state.productDetails[boxId] || createEmptyDetail(boxId);
  const draft = collectDetailDraft(boxId);
  const title = (draft.title || detail.title || "").trim();
  const description = (draft.description || detail.description || "").trim();
  const imageDownloads = (detail.images || [])
    .map((image, index) => ({
      url: getImageSource(image),
      name: image?.name || `${boxId}-photo-${index + 1}`,
    }))
    .filter((image) => image.url);

  let copied = false;
  let copyError = null;
  try {
    await copyTextToClipboard(`${title};${description}`);
    copied = true;
  } catch (error) {
    copyError = error;
  }

  downloadImages(imageDownloads);
  const photoText = imageDownloads.length
    ? ` Downloading ${imageDownloads.length} photo${imageDownloads.length === 1 ? "" : "s"}.`
    : " No photos to download.";
  if (copied) {
    setSaveMessage(`Copied listing text for ${boxId}.${photoText}`, {
      kind: "success",
      heading: "Copied",
    });
  } else {
    setSaveMessage(
      `${copyError?.message || "Clipboard copy was blocked by the browser."}${photoText}`,
      { kind: "warning" },
    );
  }
  renderSaveToast();
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy selection command below. Some browsers expose
      // navigator.clipboard but deny writeText in automated or stricter contexts.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard copy is not available in this browser.");
  }
}

function downloadImages(images) {
  images.forEach((image, index) => {
    window.setTimeout(() => {
      const link = document.createElement("a");
      link.href = image.url;
      link.download = safeDownloadName(image.name, index);
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
    }, index * 120);
  });
}

function safeDownloadName(name, index) {
  const fallback = `photo-${index + 1}`;
  const cleaned = String(name || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-");
  return cleaned || fallback;
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

function buildCategorySummary(catalogName, rows) {
  const catalog = CATALOGS[catalogName];
  const categoryRows = rows
    .filter((row) => rowBelongsToCatalog(row, catalog))
    .sort((left, right) => compareBoxIds(left.boxId, right.boxId, "asc"));
  const archivedRows = categoryRows.filter((row) => row.archived).length;
  const hiddenRows = categoryRows.filter((row) => row.hidden).length;
  const listedValue = categoryRows.reduce((total, row) => total + parseCurrency(row.priceListed), 0);

  return {
    key: catalogName,
    catalog,
    rows: categoryRows,
    totalRows: categoryRows.length,
    presentRows: categoryRows.length - archivedRows,
    archivedRows,
    hiddenRows,
    listedValue,
    nextBoxId: getNextAvailableBoxId(catalog, rows),
  };
}

function categoryCard(summary) {
  const { key, catalog } = summary;
  return `
    <article class="category-card">
      <div class="category-card-main">
        <p class="category-range">Box IDs ${escapeHtml(catalog.rangeLabel || `${catalog.from}-${catalog.to}`)}</p>
        <h3>${escapeHtml(catalog.label)}</h3>
        <p>${escapeHtml(catalog.description || "")}</p>
      </div>
      <dl class="category-stats">
        <div>
          <dt>Total</dt>
          <dd>${summary.totalRows}</dd>
        </div>
        <div>
          <dt>Present</dt>
          <dd>${summary.presentRows}</dd>
        </div>
        <div>
          <dt>Archived</dt>
          <dd>${summary.archivedRows}</dd>
        </div>
        <div>
          <dt>Hidden</dt>
          <dd>${summary.hiddenRows}</dd>
        </div>
      </dl>
      <div class="category-card-footer">
        <span>${escapeHtml(currencyFormatter.format(summary.listedValue))} listed</span>
        <span>${summary.nextBoxId ? `Next ${escapeHtml(summary.nextBoxId)}` : "Range full"}</span>
      </div>
      <a class="button primary category-open-button" data-route href="${appPath(`/${encodeURIComponent(key)}`)}">Open ${escapeHtml(catalog.label)}</a>
    </article>
  `;
}

function renderCatalogAnalytics(items) {
  const analytics = buildCatalogAnalytics(items);
  const live = analytics.live;
  const sold = analytics.sold;
  const periodLabel = getSalesPeriodLabel();
  const selectedMode = state.salesPeriodMode || "all";

  return `
    <div class="analysis-grid">
      <section class="analysis-card">
        <div class="analysis-heading">
          <div>
            <h2>Live action</h2>
            <p>Active listings that may need price, ad, or tracking work.</p>
          </div>
          <span class="detail-pill ${live.staleCount ? "pill-hidden" : "pill-public"}">${live.staleCount} stale</span>
        </div>
        <div class="analysis-metrics">
          ${analysisMetric("Active", live.count)}
          ${analysisMetric("Listed value", currencyFormatter.format(live.listedValue))}
          ${analysisMetric("Revised price", live.revisedCount)}
          ${analysisMetric("Boost notes", live.boostedCount)}
          ${analysisMetric(`${STALE_LISTING_DAYS}+ days`, live.staleCount)}
          ${analysisMetric("No date signal", live.noDateCount)}
        </div>
        ${
          live.actionRows.length
            ? `<div class="analysis-list">
                <h3>Needs attention</h3>
                ${live.actionRows.map(actionRowItem).join("")}
              </div>`
            : `<p class="analysis-empty">No active listings are over ${STALE_LISTING_DAYS} days from the latest tracking signal.</p>`
        }
      </section>

      <section class="analysis-card">
        <div class="analysis-heading">
          <div>
            <h2>Sold analysis</h2>
            <p>Archived items by channel, price, expense, and ad notes for ${escapeHtml(periodLabel)}.</p>
          </div>
          <span class="detail-pill">${sold.count} sold</span>
        </div>
        <div class="sales-period-controls">
          <label class="search-field compact-field">
            <span>View</span>
            <select id="sales-period-mode">
              <option value="all" ${state.salesPeriodMode === "all" ? "selected" : ""}>All time</option>
              <option value="year" ${state.salesPeriodMode === "year" ? "selected" : ""}>Year</option>
              <option value="month" ${state.salesPeriodMode === "month" ? "selected" : ""}>Month</option>
            </select>
          </label>
          <label class="search-field compact-field">
            <span>Year</span>
            <select id="sales-period-year" ${selectedMode === "all" ? "disabled" : ""}>
              ${renderYearOptions(items)}
            </select>
          </label>
          <label class="search-field compact-field">
            <span>Month</span>
            <select id="sales-period-month" ${selectedMode !== "month" ? "disabled" : ""}>
              ${renderMonthOptions()}
            </select>
          </label>
          <label class="search-field compact-field">
            <span>Week</span>
            <select id="sales-period-week" ${selectedMode !== "month" ? "disabled" : ""}>
              ${renderWeekOptions()}
            </select>
          </label>
        </div>
        <div class="analysis-metrics">
          ${analysisMetric("Revenue", currencyFormatter.format(sold.revenue))}
          ${analysisMetric("Net est.", currencyFormatter.format(sold.estimatedNet))}
          ${analysisMetric("Avg sale", currencyFormatter.format(sold.averageSale))}
          ${analysisMetric("Discount", currencyFormatter.format(sold.discount))}
          ${analysisMetric("Self expense", currencyFormatter.format(sold.selfExpense))}
          ${analysisMetric("Ad notes est.", currencyFormatter.format(sold.adSpend))}
        </div>
        <div class="analysis-split">
          <div class="analysis-list">
            <h3>Sold through</h3>
            ${
              sold.channels.length
                ? sold.channels.map(channelRow).join("")
                : `<p class="analysis-empty">No sold channel data yet.</p>`
            }
          </div>
          <div class="analysis-list">
            <h3>Buyer / delivery</h3>
            ${dataQualityRow("Delivery sales", sold.deliveryCount)}
            ${dataQualityRow("Avg delivery min", sold.averageDeliveryMinutes ? Math.round(sold.averageDeliveryMinutes) : 0)}
            ${dataQualityRow("Cash payments", sold.cashCount)}
            ${dataQualityRow("Zelle payments", sold.zelleCount)}
          </div>
          <div class="analysis-list">
            <h3>Data cleanup</h3>
            ${dataQualityRow("Missing final price", sold.missingFinalPriceRows)}
            ${dataQualityRow("Missing sold through", sold.missingSoldThroughRows)}
            ${dataQualityRow("Missing sold day", sold.missingSoldDayRows)}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderBusinessPriorityBoard(items) {
  const liveScores = items
    .filter((row) => !row.archived)
    .map(scoreLiveItem)
    .sort((left, right) => right.score - left.score);
  const visibleLiveScores = liveScores.slice(0, 6);
  const hiddenLiveScores = liveScores.slice(6);
  const quickWins = items
    .filter((row) => !row.archived)
    .map(scoreLiveItem)
    .filter((entry) => entry.quickWin)
    .sort((left, right) => right.quickWinScore - left.quickWinScore)
    .slice(0, 4);
  const soldWinners = items
    .filter((row) => row.archived)
    .map(scoreSoldItem)
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
  const adLessons = items
    .filter((row) => row.archived && hasBoostNotes(row))
    .map(scoreSoldItem)
    .sort((left, right) => right.adSignalScore - left.adSignalScore)
    .slice(0, 5);

  return `
    <div class="business-board">
      <section class="business-panel priority-panel">
        <div class="business-panel-heading">
          <h2>Unit health rank</h2>
          <p>Highest scores are the active listings most likely to need action.</p>
        </div>
        ${
          liveScores.length
            ? `${visibleLiveScores.map(liveRankRow).join("")}
               ${
                 hiddenLiveScores.length
                   ? `<details class="expand-health-list">
                        <summary>Show all ${liveScores.length} ranked units</summary>
                        ${hiddenLiveScores.map(liveRankRow).join("")}
                      </details>`
                   : ""
               }`
            : `<p class="analysis-empty">No live items to rank.</p>`
        }
      </section>

      <section class="business-panel">
        <div class="business-panel-heading">
          <h2>Quick wins</h2>
          <p>Items where a small listing, pricing, or ad move could help.</p>
        </div>
        ${quickWins.length ? quickWins.map(quickWinRow).join("") : `<p class="analysis-empty">No obvious quick wins found from current signals.</p>`}
      </section>

      <section class="business-panel">
        <div class="business-panel-heading">
          <h2>Sold winners</h2>
          <p>Good products or marketing patterns to repeat.</p>
        </div>
        ${soldWinners.length ? soldWinners.map(soldWinnerRow).join("") : `<p class="analysis-empty">No sold winners can be ranked yet.</p>`}
      </section>

      <section class="business-panel">
        <div class="business-panel-heading">
          <h2>Ad lessons</h2>
          <p>Boost notes compared with sale results.</p>
        </div>
        ${adLessons.length ? adLessons.map(adLessonRow).join("") : `<p class="analysis-empty">No archived items with boost notes yet.</p>`}
      </section>
    </div>
  `;
}

function buildCatalogAnalytics(items) {
  const liveRows = items.filter((row) => !row.archived);
  const allSoldRows = items.filter((row) => row.archived);
  const soldRows = filterSoldRowsByPeriod(allSoldRows);
  const now = new Date();

  const liveActionRows = liveRows
    .map((row) => {
      const listedDate = getFirstListedDate(row, now);
      const ageDays = listedDate ? daysBetween(listedDate, now) : null;
      const boostText = [row.boost, row.boost2].filter(Boolean).join(" | ");
      return {
        row,
        ageDays,
        trackingDate: listedDate,
        boostText,
        price: getActivePrice(row),
        reason: ageDays == null ? "No listing date" : `${ageDays} days listed`,
      };
    })
    .filter((entry) => entry.ageDays == null || entry.ageDays >= STALE_LISTING_DAYS)
    .sort((left, right) => {
      if (left.ageDays == null && right.ageDays == null) {
        return compareBoxIds(left.row.boxId, right.row.boxId, "asc");
      }
      if (left.ageDays == null) {
        return -1;
      }
      if (right.ageDays == null) {
        return 1;
      }
      return right.ageDays - left.ageDays;
    })
    .slice(0, 6);

  const soldWithFinalPrice = soldRows.filter((row) => parseCurrency(row.finalPrice) > 0);
  const soldRevenue = soldRows.reduce((total, row) => total + parseCurrency(row.finalPrice), 0);
  const soldListedValue = soldRows.reduce((total, row) => total + parseCurrency(row.priceListed), 0);
  const selfExpense = soldRows.reduce((total, row) => total + parseExpenseCost(row.selfExpense), 0);
  const adSpend = soldRows.reduce((total, row) => total + estimateAdSpend(row), 0);
  const channels = buildChannelBreakdown(soldRows);
  const buyerSignals = soldRows.map(parseBuyerSignals);
  const deliveryMinutes = buyerSignals
    .map((signal) => signal.deliveryMinutes)
    .filter((value) => value > 0);

  return {
    live: {
      count: liveRows.length,
      listedValue: liveRows.reduce((total, row) => total + getActivePrice(row), 0),
      revisedCount: liveRows.filter((row) => parseCurrency(row.revised) > 0).length,
      boostedCount: liveRows.filter((row) => hasBoostNotes(row)).length,
      staleCount: liveActionRows.filter((entry) => entry.ageDays != null).length,
      noDateCount: liveRows.filter((row) => !getFirstListedDate(row, now)).length,
      actionRows: liveActionRows,
    },
    sold: {
      count: soldRows.length,
      revenue: soldRevenue,
      listedValue: soldListedValue,
      averageSale: soldWithFinalPrice.length ? soldRevenue / soldWithFinalPrice.length : 0,
      discount: Math.max(0, soldListedValue - soldRevenue),
      selfExpense,
      adSpend,
      estimatedNet: soldRevenue - selfExpense - adSpend,
      allCount: allSoldRows.length,
      missingFinalPriceRows: soldRows.filter((row) => parseCurrency(row.finalPrice) <= 0),
      missingSoldThroughRows: soldRows.filter((row) => !String(row.soldThrough || "").trim()),
      missingSoldDayRows: soldRows.filter((row) => !String(row.soldDay || "").trim()),
      deliveryCount: buyerSignals.filter((signal) => signal.delivery).length,
      averageDeliveryMinutes: deliveryMinutes.length
        ? deliveryMinutes.reduce((total, value) => total + value, 0) / deliveryMinutes.length
        : 0,
      cashCount: buyerSignals.filter((signal) => signal.payment === "cash").length,
      zelleCount: buyerSignals.filter((signal) => signal.payment === "zelle").length,
      channels,
    },
  };
}

function analysisMetric(label, value) {
  return `
    <div class="analysis-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderYearOptions(items) {
  const currentYear = new Date().getFullYear();
  const years = new Set([currentYear, Number(state.salesPeriodYear) || currentYear]);
  items
    .filter((row) => row.archived)
    .forEach((row) => {
      const soldDate = parseLooseDate(row.soldDay);
      if (soldDate) {
        years.add(soldDate.getFullYear());
      }
    });

  return Array.from(years)
    .filter((year) => Number.isInteger(year))
    .sort((left, right) => right - left)
    .map(
      (year) =>
        `<option value="${year}" ${Number(state.salesPeriodYear) === year ? "selected" : ""}>${year}</option>`,
    )
    .join("");
}

function renderMonthOptions() {
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const label = new Date(2026, index, 1).toLocaleDateString(undefined, { month: "long" });
    return `<option value="${month}" ${Number(state.salesPeriodMonth) === month ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
}

function renderWeekOptions() {
  const weekCount = getWeeksInSelectedMonth();
  const options = [`<option value="" ${state.salesPeriodWeek ? "" : "selected"}>All weeks</option>`];
  for (let week = 1; week <= weekCount; week += 1) {
    const range = getSelectedMonthWeekRange(week);
    const label = range ? `Week ${week} (${range.start.getDate()}-${range.end.getDate()})` : `Week ${week}`;
    options.push(
      `<option value="${week}" ${String(state.salesPeriodWeek) === String(week) ? "selected" : ""}>${escapeHtml(label)}</option>`,
    );
  }
  return options.join("");
}

function actionRowItem(entry) {
  const row = entry.row;
  const title = stripBoxIdPrefix(row.itemName || "", row.boxId) || "Untitled item";
  const reasonClass = entry.ageDays == null ? "pill-hidden" : "pill-public";
  return `
    <article class="analysis-row">
      <div>
        <a class="boxid-link" data-route href="${appPath(`/${encodeURIComponent(row.boxId)}`)}">${escapeHtml(row.boxId)}</a>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(entry.boostText || "No boost/ad note recorded.")}</p>
      </div>
      <div class="analysis-row-meta">
        <span class="detail-pill ${reasonClass}">${escapeHtml(entry.reason)}</span>
        <span>${escapeHtml(currencyFormatter.format(entry.price))}</span>
      </div>
    </article>
  `;
}

function channelRow(channel) {
  return `
    <div class="analysis-breakdown-row">
      <span>${escapeHtml(channel.label)}</span>
      <strong>${channel.count} / ${escapeHtml(currencyFormatter.format(channel.revenue))}</strong>
    </div>
  `;
}

function dataQualityRow(label, rowsOrCount) {
  const rows = Array.isArray(rowsOrCount) ? rowsOrCount : [];
  const count = Array.isArray(rowsOrCount) ? rowsOrCount.length : Number(rowsOrCount || 0);
  if (!rows.length) {
    return `
      <div class="analysis-breakdown-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(count))}</strong>
      </div>
    `;
  }

  return `
    <details class="cleanup-details">
      <summary>
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(count))}</strong>
      </summary>
      <div class="cleanup-list">
        ${rows.slice(0, 30).map(cleanupItem).join("")}
        ${rows.length > 30 ? `<p class="analysis-empty">Showing first 30 of ${rows.length} items.</p>` : ""}
      </div>
    </details>
  `;
}

function cleanupItem(row) {
  const title = stripBoxIdPrefix(row.itemName || "", row.boxId) || "Untitled item";
  return `
    <a class="cleanup-item" data-route href="${appPath(`/${encodeURIComponent(row.boxId)}`)}">
      <span>${escapeHtml(row.boxId || "UNKNOWN")}</span>
      <strong>${escapeHtml(title)}</strong>
    </a>
  `;
}

function liveRankRow(entry) {
  return `
    <article class="business-rank-row severity-${escapeAttribute(entry.severity)}">
      <div class="rank-score">${entry.score}</div>
      <div class="rank-main">
        <a class="boxid-link" data-route href="${appPath(`/${encodeURIComponent(entry.row.boxId)}`)}">${escapeHtml(entry.row.boxId)}</a>
        <strong>${escapeHtml(entry.title)}</strong>
        <p>${escapeHtml(entry.primaryAdvice)}</p>
        <div class="rank-tags">
          ${entry.reasons.slice(0, 4).map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
        </div>
      </div>
      <div class="rank-meta">
        <span>${escapeHtml(currencyFormatter.format(entry.price))}</span>
        <span>${entry.ageDays == null ? "No date" : `${entry.ageDays} days`}</span>
      </div>
    </article>
  `;
}

function quickWinRow(entry) {
  return `
    <article class="business-mini-row">
      <div>
        <a class="boxid-link" data-route href="${appPath(`/${encodeURIComponent(entry.row.boxId)}`)}">${escapeHtml(entry.row.boxId)}</a>
        <strong>${escapeHtml(entry.title)}</strong>
      </div>
      <p>${escapeHtml(entry.quickWin)}</p>
    </article>
  `;
}

function soldWinnerRow(entry) {
  return `
    <article class="business-mini-row">
      <div>
        <a class="boxid-link" data-route href="${appPath(`/${encodeURIComponent(entry.row.boxId)}`)}">${escapeHtml(entry.row.boxId)}</a>
        <strong>${escapeHtml(entry.title)}</strong>
      </div>
      <p>${escapeHtml(entry.lesson)}</p>
    </article>
  `;
}

function adLessonRow(entry) {
  return `
    <article class="business-mini-row">
      <div>
        <a class="boxid-link" data-route href="${appPath(`/${encodeURIComponent(entry.row.boxId)}`)}">${escapeHtml(entry.row.boxId)}</a>
        <strong>${escapeHtml(entry.title)}</strong>
      </div>
      <p>${escapeHtml(entry.adLesson)}</p>
    </article>
  `;
}

function scoreLiveItem(row) {
  const now = new Date();
  const detail = state.productDetails[row.boxId] || {};
  const listedDate = getFirstListedDate(row, now);
  const latestActionDate = getLiveTrackingDate(row, now);
  const ageDays = listedDate ? daysBetween(listedDate, now) : null;
  const idleDays = latestActionDate ? daysBetween(latestActionDate, now) : ageDays;
  const price = getActivePrice(row);
  const hasPrice = price > 0;
  const boosted = hasBoostNotes(row);
  const hasImages = Array.isArray(detail.images) && detail.images.length > 0;
  const hasListingContent = Boolean(String(detail.title || "").trim() || String(detail.description || "").trim());
  const title = stripBoxIdPrefix(detail.title || row.itemName || "", row.boxId) || "Untitled item";
  const reasons = [];
  let score = 0;

  if (ageDays == null) {
    score += 28;
    reasons.push("No listing date");
  } else if (ageDays >= 180) {
    score += 34;
    reasons.push(`${ageDays} days listed`);
  } else if (ageDays >= STALE_LISTING_DAYS) {
    score += 25;
    reasons.push(`${ageDays} days listed`);
  } else if (ageDays >= 90) {
    score += 12;
    reasons.push(`${ageDays} days listed`);
  }

  if (idleDays != null && idleDays >= 45) {
    score += 10;
    reasons.push(`${idleDays} days no action`);
  }

  if (!hasPrice) {
    score += 24;
    reasons.push("No usable price");
  }
  if (!boosted && ageDays != null && ageDays >= 60) {
    score += 16;
    reasons.push("No boost note");
  }
  if (boosted && ageDays != null && ageDays >= 120) {
    score += 12;
    reasons.push("Boosted but still unsold");
  }
  if (!hasImages) {
    score += 18;
    reasons.push("No photos");
  }
  if (!hasListingContent) {
    score += 10;
    reasons.push("Missing title/description");
  }
  if (parseCurrency(row.revised) > 0 && parseCurrency(row.revised) < parseCurrency(row.priceListed)) {
    reasons.push("Already discounted");
    score += ageDays != null && ageDays >= 120 ? 8 : 2;
  }

  const primaryAdvice = buildLiveAdvice({ ageDays, idleDays, boosted, hasPrice, hasImages, hasListingContent, row });
  const quickWin = buildQuickWin({ ageDays, idleDays, boosted, hasPrice, hasImages, hasListingContent, row });

  return {
    row,
    title,
    score,
    severity: score >= 55 ? "bad" : score >= 30 ? "warn" : "ok",
    ageDays,
    price,
    reasons: reasons.length ? reasons : ["Looks healthy"],
    primaryAdvice,
    quickWin,
    quickWinScore: (quickWin ? 30 : 0) + score,
  };
}

function buildLiveAdvice({ ageDays, boosted, hasPrice, hasImages, hasListingContent, row }) {
  if (!hasPrice) {
    return "Set a real price before spending time on promotion.";
  }
  if (!hasImages) {
    return "Add photos first; ads without photos waste attention.";
  }
  if (!hasListingContent) {
    return "Improve title/description before boosting.";
  }
  if (ageDays == null) {
    return "Add a platform listing date so listing age can be measured.";
  }
  if (ageDays >= 180 && boosted) {
    return "Stop repeating the same ad; change price, photos, title, or channel.";
  }
  if (ageDays >= STALE_LISTING_DAYS && !boosted) {
    return "Refresh listing and test a small boost after improving title/photos.";
  }
  if (ageDays >= 90 && parseCurrency(row.revised) <= 0) {
    return "Consider a revised price or bundle offer.";
  }
  return "Monitor. No urgent action from current signals.";
}

function buildQuickWin({ ageDays, idleDays, boosted, hasPrice, hasImages, hasListingContent, row }) {
  if (hasPrice && !hasImages) {
    return "Add photos; this is the fastest listing-quality improvement.";
  }
  if (hasImages && !hasListingContent) {
    return "Write a stronger title/description before paying for ads.";
  }
  if (ageDays != null && ageDays >= STALE_LISTING_DAYS && !boosted) {
    return "Refresh listing, then try a small 3-day boost.";
  }
  if (idleDays != null && idleDays >= 45) {
    return "Update listing content or relist; no recent action is recorded.";
  }
  if (ageDays != null && ageDays >= 120 && parseCurrency(row.revised) <= 0) {
    return "Test a revised price before another ad spend.";
  }
  if (boosted && ageDays != null && ageDays >= 120) {
    return "Promotion alone is not solving it; change creative or channel.";
  }
  return "";
}

function scoreSoldItem(row) {
  const detail = state.productDetails[row.boxId] || {};
  const finalPrice = parseCurrency(row.finalPrice);
  const listedPrice = parseCurrency(row.priceListed);
  const expense = parseExpenseCost(row.selfExpense);
  const adSpend = estimateAdSpend(row);
  const net = finalPrice - expense - adSpend;
  const soldDate = parseLooseDate(row.soldDay);
  const firstSignal = getFirstMarketingDate(row);
  const saleDays = soldDate && firstSignal ? daysBetween(firstSignal, soldDate) : null;
  const discount = listedPrice > 0 && finalPrice > 0 ? listedPrice - finalPrice : 0;
  const boosted = hasBoostNotes(row);
  const title = stripBoxIdPrefix(detail.title || row.itemName || "", row.boxId) || "Untitled item";
  let score = 0;

  if (finalPrice > 0) {
    score += Math.min(35, Math.round(finalPrice / 20));
  }
  if (net > 0) {
    score += Math.min(30, Math.round(net / 20));
  }
  if (saleDays != null && saleDays <= 7) {
    score += 30;
  } else if (saleDays != null && saleDays <= 30) {
    score += 18;
  }
  if (discount <= 0 && finalPrice > 0 && listedPrice > 0) {
    score += 18;
  }
  if (!boosted && finalPrice > 0) {
    score += 12;
  }

  const speedText = saleDays == null ? "sale speed unknown" : saleDays <= 1 ? "sold same/next day" : `sold in ${saleDays} days`;
  const priceText =
    discount <= 0 && finalPrice > 0 && listedPrice > 0
      ? "without discount"
      : discount > 0
        ? `${currencyFormatter.format(discount)} discount`
        : "price quality unknown";
  const channel = normalizeSoldThrough(row.soldThrough) || "unknown channel";
  const adLesson = buildAdLesson({ row, boosted, saleDays, adSpend, finalPrice, channel, soldDate });

  return {
    row,
    title,
    score,
    adSignalScore: (boosted ? 20 : 0) + (saleDays != null && saleDays <= 14 ? 20 : 0) + (finalPrice > 0 ? 8 : 0),
    lesson: `${speedText}, ${priceText}, ${channel}. ${net > 0 ? `${currencyFormatter.format(net)} est. net.` : "Net needs review."}`,
    adLesson,
  };
}

function buildAdLesson({ row, boosted, saleDays, adSpend, finalPrice, channel, soldDate }) {
  const campaigns = parseBoostCampaigns([row.boost, row.boost2].join("; "));
  const matchingCampaign = soldDate
    ? campaigns.find((campaign) => soldDate >= campaign.startDate && soldDate <= campaign.endDate)
    : null;
  const nearbyCampaign = soldDate
    ? campaigns.find((campaign) => {
        const daysAfter = daysBetween(campaign.endDate, soldDate);
        return soldDate >= campaign.startDate && daysAfter <= 7;
      })
    : null;

  if (!boosted) {
    return `Sold without recorded boost on ${channel}; this product/channel may not need paid ads.`;
  }
  if (matchingCampaign) {
    return `Sold during boost campaign; ad likely helped. Estimated campaign cost ${currencyFormatter.format(matchingCampaign.cost)}.`;
  }
  if (nearbyCampaign) {
    return `Sold shortly after boost ended; ad may have assisted. Estimated ad spend ${currencyFormatter.format(adSpend)}.`;
  }
  if (saleDays != null && saleDays <= 7 && finalPrice > 0) {
    return `Boost likely helped: sold quickly after marketing signal; recorded ad spend about ${currencyFormatter.format(adSpend)}.`;
  }
  if (saleDays != null && saleDays > 45) {
    return `Boost did not create a fast sale; change creative, price, or channel before repeating.`;
  }
  return `Boost recorded; compare messages/views manually before repeating this campaign.`;
}

function getFirstMarketingDate(row) {
  const dates = [
    ...getListingDates(row),
    parseLooseDate(row.priceChangedDate),
    ...datesFromText([row.boost, row.boost2, row.notes].join(" ")),
  ].filter(Boolean);
  return dates.sort((left, right) => left.getTime() - right.getTime())[0] || null;
}

function buildChannelBreakdown(rows) {
  const channels = new Map();
  rows.forEach((row) => {
    const key = normalizeSoldThrough(row.soldThrough);
    if (!key) {
      return;
    }
    const existing = channels.get(key) || { label: key, count: 0, revenue: 0 };
    existing.count += 1;
    existing.revenue += parseCurrency(row.finalPrice);
    channels.set(key, existing);
  });

  return Array.from(channels.values()).sort((left, right) => right.count - left.count || right.revenue - left.revenue);
}

function normalizeSoldThrough(value) {
  const text = String(value || "").trim().toLowerCase().replace(/[,\s]+$/g, "");
  if (!text) {
    return "";
  }
  if (["fb", "facebook", "facebook marketplace"].includes(text)) {
    return "Facebook";
  }
  if (["craiglist", "craigslist"].includes(text)) {
    return "Craigslist";
  }
  if (text === "ebay") {
    return "eBay";
  }
  if (text === "mercari") {
    return "Mercari";
  }
  return text.replace(/\b\w/g, (match) => match.toUpperCase());
}

function getActivePrice(row) {
  const revised = parseCurrency(row.revised);
  return revised > 0 ? revised : parseCurrency(row.priceListed);
}

function parseExpenseCost(value) {
  const amount = parseCurrency(value);
  return Math.abs(amount);
}

function estimateAdSpend(row) {
  return parseBoostCampaigns([row.boost, row.boost2].join("; ")).reduce(
    (total, campaign) => total + campaign.cost,
    0,
  );
}

function parseBoostCampaigns(value) {
  const text = String(value || "");
  const segments = text.split(/[;\n]+/).map((segment) => segment.trim()).filter(Boolean);
  return segments
    .map(parseBoostCampaignSegment)
    .filter(Boolean);
}

function parseBoostCampaignSegment(segment) {
  const startDate = parseLooseDate(segment);
  const amountMatches = Array.from(segment.matchAll(/(?:\$(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\$)/g));
  if (!amountMatches.length) {
    return null;
  }

  const amountMatch = amountMatches[amountMatches.length - 1];
  const amount = Number(amountMatch[1] || amountMatch[2] || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const daysMatch = segment.match(/(\d+)\s*days?/i);
  const days = daysMatch ? Number(daysMatch[1]) : 1;
  const amountContext = segment.slice(Math.max(0, amountMatch.index - 18), amountMatch.index + amountMatch[0].length + 24).toLowerCase();
  const totalCost = amountContext.includes("total") ? amount : amount * Math.max(1, days);
  const fallbackStart = startDate || new Date();
  const endDate = addDays(fallbackStart, Math.max(1, days));

  return {
    startDate: fallbackStart,
    endDate,
    days: Math.max(1, days),
    cost: totalCost,
    raw: segment,
  };
}

function sumDollarMentions(value) {
  const text = String(value || "");
  const matches = text.matchAll(/(?:\$(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\$)/g);
  let total = 0;
  for (const match of matches) {
    total += Number(match[1] || match[2] || 0);
  }
  return total;
}

function hasBoostNotes(row) {
  return Boolean(String(row.boost || "").trim() || String(row.boost2 || "").trim());
}

function getLiveTrackingDate(row, now = new Date()) {
  return latestDate(
    [
      parseLooseDate(row.priceChangedDate, now),
      latestDateFromText([row.boost, row.boost2, row.notes].join(" "), now),
      latestDate(getListingDates(row, now)),
    ].filter(Boolean),
  );
}

function getFirstListedDate(row, now = new Date()) {
  return earliestDate(getListingDates(row, now));
}

function getListingDates(row, now = new Date()) {
  return ["facebook", "craiglist", "ebay", "mercari"]
    .map((key) => parseLooseDate(row[key], now))
    .filter(Boolean);
}

function latestDateFromText(value, now = new Date()) {
  const dates = datesFromText(value, now);
  return dates.sort((left, right) => right.getTime() - left.getTime())[0] || null;
}

function datesFromText(value, now = new Date()) {
  const dates = [];
  const text = String(value || "");
  const matches = text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g);
  for (const match of matches) {
    const parsed = parseDateParts(match[1], match[2], match[3], now);
    if (parsed) {
      dates.push(parsed);
    }
  }
  return dates;
}

function parseLooseDate(value, now = new Date()) {
  const match = String(value || "").match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  return match ? parseDateParts(match[1], match[2], match[3], now) : null;
}

function filterSoldRowsByPeriod(rows) {
  const mode = state.salesPeriodMode || "all";
  if (mode === "all") {
    return rows;
  }

  const year = getSelectedSalesYear();
  const month = getSelectedSalesMonth();
  const selectedWeek = parseSelectedSalesWeek();
  const weekRange = mode === "month" && selectedWeek ? getSelectedMonthWeekRange(selectedWeek) : null;

  return rows.filter((row) => {
    const soldDate = parseLooseDate(row.soldDay, new Date(year, month - 1, 1));
    if (!soldDate) {
      return false;
    }

    if (mode === "year") {
      return soldDate.getFullYear() === year;
    }
    if (mode === "month") {
      const sameMonth = soldDate.getFullYear() === year && soldDate.getMonth() === month - 1;
      if (!sameMonth) {
        return false;
      }
      return weekRange ? soldDate >= weekRange.start && soldDate <= weekRange.end : true;
    }
    return true;
  });
}

function getSalesPeriodLabel() {
  const mode = state.salesPeriodMode || "all";
  const year = getSelectedSalesYear();
  const month = getSelectedSalesMonth();

  if (mode === "year") {
    return String(year);
  }
  if (mode === "month") {
    const monthLabel = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const selectedWeek = parseSelectedSalesWeek();
    const weekRange = selectedWeek ? getSelectedMonthWeekRange(selectedWeek) : null;
    return weekRange
      ? `${monthLabel}, week ${selectedWeek} (${weekRange.start.getDate()}-${weekRange.end.getDate()})`
      : monthLabel;
  }
  return "all time";
}

function getSelectedSalesYear() {
  return Number(state.salesPeriodYear) || new Date().getFullYear();
}

function getSelectedSalesMonth() {
  const month = Number(state.salesPeriodMonth);
  return month >= 1 && month <= 12 ? month : new Date().getMonth() + 1;
}

function getWeeksInSelectedMonth() {
  const year = getSelectedSalesYear();
  const month = getSelectedSalesMonth();
  const daysInMonth = new Date(year, month, 0).getDate();
  return Math.ceil(daysInMonth / 7);
}

function parseSelectedSalesWeek() {
  const raw = String(state.salesPeriodWeek || "").trim();
  if (!raw) {
    return null;
  }
  const week = Number(raw);
  return Number.isInteger(week) && week > 0 ? week : null;
}

function getSelectedMonthWeekRange(week) {
  const weekNumber = Number(week);
  if (!Number.isInteger(weekNumber) || weekNumber < 1) {
    return null;
  }

  const year = getSelectedSalesYear();
  const month = getSelectedSalesMonth();
  const daysInMonth = new Date(year, month, 0).getDate();
  const startDay = (weekNumber - 1) * 7 + 1;
  if (startDay > daysInMonth) {
    return null;
  }

  const endDay = Math.min(startDay + 6, daysInMonth);
  return {
    start: new Date(year, month - 1, startDay),
    end: new Date(year, month - 1, endDay, 23, 59, 59, 999),
  };
}

function parseDateParts(monthText, dayText, yearText, now = new Date()) {
  const month = Number(monthText);
  const day = Number(dayText);
  let year = yearText ? Number(yearText) : now.getFullYear();
  if (year < 100) {
    year += 2000;
  }

  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function daysBetween(left, right) {
  return Math.max(0, Math.floor((right.getTime() - left.getTime()) / (1000 * 60 * 60 * 24)));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function latestDate(dates) {
  return dates.filter(Boolean).sort((left, right) => right.getTime() - left.getTime())[0] || null;
}

function earliestDate(dates) {
  return dates.filter(Boolean).sort((left, right) => left.getTime() - right.getTime())[0] || null;
}

function parseBuyerSignals(row) {
  const text = [row.buyerDescription, row.notes].join(" ").toLowerCase();
  const delivery = /\bdeliver|delivery|delivered\b/.test(text);
  const minutes = Array.from(text.matchAll(/(\d+)\s*min/g)).map((match) => Number(match[1]));
  const locationMatch = text.match(/\b(nj|jersey city|brooklyn|staten island|si|manhattan|queens|bronx)\b/i);
  let payment = "";
  if (/\bzelle\b/.test(text)) {
    payment = "zelle";
  } else if (/\bcash\b/.test(text)) {
    payment = "cash";
  }

  return {
    delivery,
    deliveryMinutes: minutes.length ? Math.max(...minutes) : 0,
    payment,
    location: locationMatch ? locationMatch[0] : "",
  };
}

function rowBelongsToCatalog(row, catalog) {
  const raw = String(row?.boxId ?? "").trim();
  const number = Number(raw);
  const hasNumericId = /^\d+$/.test(raw) && Number.isInteger(number);

  if (hasNumericId) {
    return getCatalogRanges(catalog).some(([from, to]) => number >= from && number <= to);
  }

  return Boolean(catalog.includeUnknown);
}

function getCatalogLabelsForRow(row) {
  return CATEGORY_ORDER.map((key) => CATALOGS[key])
    .filter((catalog) => rowBelongsToCatalog(row, catalog))
    .map((catalog) => catalog.label);
}

function getNextAvailableBoxId(catalog, rows) {
  const used = new Set(rows.map((row) => String(row?.boxId ?? "").trim()).filter(Boolean));
  for (const [from, to] of getCatalogRanges(catalog)) {
    for (let number = from; number <= to; number += 1) {
      if (!used.has(String(number))) {
        return String(number);
      }
    }
  }
  return "";
}

function getCatalogRanges(catalog) {
  return Array.isArray(catalog.ranges) && catalog.ranges.length ? catalog.ranges : [[catalog.from, catalog.to]];
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

  if (parts[0] === "health-rank") {
    return {
      page: "health-rank",
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

function setSaveMessage(message, options = {}) {
  state.saveMessage = message;
  const kind = options.kind || inferToastKind(message);
  const id = Date.now() + Math.random();
  state.saveToast = {
    id,
    message,
    kind,
    heading: options.heading || "",
  };

  if (saveToastTimer) {
    window.clearTimeout(saveToastTimer);
    saveToastTimer = null;
  }

  if (options.autoDismiss === false) {
    return;
  }

  saveToastTimer = window.setTimeout(() => {
    if (state.saveToast?.id !== id) {
      return;
    }
    state.saveToast = null;
    renderSaveToast();
  }, options.duration || 3200);
}

function renderSaveToast() {
  document.querySelector(".save-toast")?.remove();
  if (!state.saveToast?.message) {
    return;
  }

  const toast = document.createElement("div");
  toast.className = `save-toast save-toast-${state.saveToast.kind || "info"}`;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.innerHTML = `
    <span class="save-toast-icon" aria-hidden="true"></span>
    <span class="save-toast-copy">
      <strong>${escapeHtml(state.saveToast.heading || toastHeadingForKind(state.saveToast.kind))}</strong>
      <span>${escapeHtml(state.saveToast.message)}</span>
    </span>
  `;
  document.body.append(toast);
}

function inferToastKind(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("saved") || text.includes("uploaded") || text.includes("imported") || text.includes("added")) {
    return "success";
  }
  if (text.includes("uploading") || text.includes("saving")) {
    return "saving";
  }
  if (text.includes("not") || text.includes("could not") || text.includes("canceled") || text.includes("read-only")) {
    return "warning";
  }
  return "info";
}

function toastHeadingForKind(kind) {
  if (kind === "success") {
    return "Saved";
  }
  if (kind === "saving") {
    return "Saving";
  }
  if (kind === "warning") {
    return "Notice";
  }
  return "Updated";
}

function setButtonSaving(button, isSaving) {
  if (!button) {
    return;
  }
  if (isSaving) {
    button.dataset.originalText = button.textContent;
    button.textContent = "Saving...";
    button.disabled = true;
    button.classList.add("is-saving");
    return;
  }
  button.textContent = button.dataset.originalText || button.textContent;
  button.disabled = false;
  button.classList.remove("is-saving");
}

function isHistoryMode() {
  return Boolean(state.viewingSnapshot?.id);
}

function formatDateTime(value) {
  if (!value) {
    return "unknown time";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function formatSnapshotOption(snapshot) {
  const date = formatDateTime(snapshot.createdAt);
  const label = snapshot.label || snapshot.reason || "Saved dashboard";
  const rows = Number.isFinite(Number(snapshot.rowCount)) ? `${snapshot.rowCount} rows` : "";
  return [date, label, rows].filter(Boolean).join(" - ");
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

function copyIconSvg() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="9" y="9" width="11" height="11" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
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

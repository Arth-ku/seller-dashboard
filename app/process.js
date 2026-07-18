import {
  loadOrderProcessHistory,
  loadOrderProcessHistoryState,
  loadOrderProcessState,
  refreshOrderProcessSheet,
} from "./store.js?v=20260718a";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETURN_WINDOW_DAYS = 30;
const SOURCE_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1nh4HWr8DAP26KziNTMGEtqs6LEkV8-Va9IDo7oTACQw/edit?usp=sharing";

const processState = {
  rows: [],
  meta: {},
  snapshots: [],
  snapshot: null,
  loaded: false,
  loading: false,
  refreshing: false,
  error: "",
  notice: "",
  query: "",
  scope: "active",
  seller: "all",
};

let pageContext = null;

export function renderOrderProcessPage(context) {
  pageContext = context;
  renderPage();
  if (!processState.loaded && !processState.loading) {
    loadCurrentProcess();
  }
}

function renderPage() {
  if (!pageContext || !isProcessRoute()) {
    return;
  }

  const { app, appPath } = pageContext;
  const rows = processState.rows.map(analyzeProcessRow).sort(compareProcessRows);
  const filteredRows = filterProcessRows(rows);
  const metrics = buildProcessMetrics(rows);
  const sellers = [...new Set(rows.map((entry) => entry.row.seller).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  const historyMode = Boolean(processState.snapshot?.id);
  const selectedHistory = historyMode ? processState.snapshot.id : "current";
  const lastImport = formatDateTime(processState.meta.lastImportAt);
  const sourceUrl =
    processState.meta.sourceSheetUrl ||
    googleSheetPageUrl(processState.meta.sourceUrl) ||
    SOURCE_SHEET_URL;

  app.innerHTML = `
    <main class="shell process-shell">
      ${
        historyMode
          ? `<section class="history-banner process-history-banner">
              <strong>Historical view</strong>
              <span>Showing the order process saved ${escapeHtml(formatDateTime(processState.snapshot.createdAt))}. Refresh is disabled.</span>
              <button id="process-current-button" class="button secondary" type="button">Back to current</button>
            </section>`
          : ""
      }

      <section class="panel process-panel">
        <div class="detail-header process-header">
          <div>
            <a class="back-link" data-route href="${appPath("/")}">Back to dashboard</a>
            <p class="eyebrow">Purchasing Workflow</p>
            <h1>Order process</h1>
            <p class="detail-subtitle">Reviews, approvals, refunds, and the 30-day return window for every ordered unit.</p>
          </div>
          <div class="process-header-actions">
            <a class="button ghost" href="${escapeAttribute(sourceUrl)}" target="_blank" rel="noopener">Open Google Sheet</a>
            <button id="process-refresh-button" class="button primary" type="button" ${
              historyMode || processState.refreshing ? "disabled" : ""
            }>
              ${processState.refreshing ? "Refreshing..." : "Refresh now"}
            </button>
          </div>
        </div>

        ${renderMetricStrip(metrics)}

        <div class="process-controls">
          <div class="process-scope-tabs" role="group" aria-label="Order process view">
            ${scopeButton("active", "Active", metrics.active)}
            ${scopeButton("return-risk", "Return risk", metrics.returnRisk)}
            ${scopeButton("refunds", "Refunds", metrics.refunds)}
            ${scopeButton("exceptions", "Exceptions", metrics.exceptions)}
            ${scopeButton("completed", "Completed", metrics.completed)}
            ${scopeButton("all", "All", metrics.total)}
          </div>

          <div class="process-filter-grid">
            <label class="search-field">
              <span>Search orders</span>
              <input id="process-search" type="search" value="${escapeAttribute(processState.query)}" placeholder="Product, order, seller, account..." />
            </label>
            <label class="search-field process-seller-field">
              <span>Seller</span>
              <select id="process-seller">
                <option value="all">All sellers</option>
                ${sellers
                  .map(
                    (seller) =>
                      `<option value="${escapeAttribute(seller)}" ${processState.seller === seller ? "selected" : ""}>${escapeHtml(seller)}</option>`,
                  )
                  .join("")}
              </select>
            </label>
            <label class="search-field process-playback-field">
              <span>Playback</span>
              <select id="process-history-select">
                <option value="current" ${selectedHistory === "current" ? "selected" : ""}>Current order process</option>
                ${processState.snapshots
                  .map(
                    (snapshot) => `
                      <option value="${escapeAttribute(snapshot.id)}" ${selectedHistory === snapshot.id ? "selected" : ""}>
                        ${escapeHtml(formatSnapshotOption(snapshot))}
                      </option>
                    `,
                  )
                  .join("")}
              </select>
            </label>
          </div>
        </div>

        <div class="process-status-line">
          <p><strong>${filteredRows.length}</strong> unit${filteredRows.length === 1 ? "" : "s"} shown</p>
          <p><strong>Last refresh:</strong> ${escapeHtml(lastImport || "Not imported yet")}</p>
          <p>${escapeHtml(processState.notice || "Google Sheet data is read-only here. Update the source sheet, then refresh.")}</p>
        </div>

        ${renderProcessContent(filteredRows)}
      </section>
    </main>
  `;

  bindPageEvents();
}

function renderMetricStrip(metrics) {
  return `
    <section class="process-metrics" aria-label="Order process summary">
      <article class="process-metric metric-danger">
        <span>Overdue reviews</span>
        <strong>${metrics.overdue}</strong>
        <small>Past the estimated return day</small>
      </article>
      <article class="process-metric metric-warning">
        <span>Due in 7 days</span>
        <strong>${metrics.dueSoon}</strong>
        <small>Review is not submitted yet</small>
      </article>
      <article class="process-metric metric-info">
        <span>Refund follow-up</span>
        <strong>${metrics.refunds}</strong>
        <small>Submitted, approved, or paid</small>
      </article>
      <article class="process-metric metric-success">
        <span>Active units</span>
        <strong>${metrics.active}</strong>
        <small>${metrics.reviewProtected} have review protection</small>
      </article>
      <article class="process-metric metric-neutral">
        <span>TIN exceptions</span>
        <strong>${metrics.trustedExceptions}</strong>
        <small>Listed before review approval</small>
      </article>
    </section>
  `;
}

function scopeButton(scope, label, count) {
  return `
    <button
      class="process-scope-button ${processState.scope === scope ? "is-active" : ""}"
      type="button"
      data-process-scope="${scope}"
      aria-pressed="${processState.scope === scope ? "true" : "false"}"
    >
      <span>${escapeHtml(label)}</span>
      <strong>${count}</strong>
    </button>
  `;
}

function renderProcessContent(rows) {
  if (processState.loading && !processState.loaded) {
    return `
      <div class="process-loading" role="status">
        <strong>Loading order process...</strong>
        <span>Reading the saved Google Sheet import.</span>
      </div>
    `;
  }

  if (processState.error) {
    return `
      <div class="process-error" role="alert">
        <strong>Could not load the order process</strong>
        <span>${escapeHtml(processState.error)}</span>
        <button id="process-retry-button" class="button secondary" type="button">Try again</button>
      </div>
    `;
  }

  if (!rows.length) {
    return `
      <div class="empty-state process-empty">
        <h2>No matching orders</h2>
        <p>Change the view, seller, or search filters.</p>
      </div>
    `;
  }

  return `
    <section class="process-list" aria-label="Order process units">
      <div class="process-list-header" aria-hidden="true">
        <span>Return window</span>
        <span>Unit and order</span>
        <span>Seller / account</span>
        <span>Next step</span>
        <span>Refund / listing</span>
      </div>
      ${rows.map(renderProcessRow).join("")}
    </section>
  `;
}

function renderProcessRow(entry) {
  const { row } = entry;
  const productName = row.productName || "Product name missing";
  const orderNumber = row.orderNumber || `Sheet row ${row.sheetRow || "unknown"}`;
  const trustedLabel = entry.trustedException
    ? `<span class="process-tag tag-trusted">TIN trusted exception</span>`
    : "";
  const earlyListingLabel = entry.earlyListingIssue
    ? `<span class="process-tag tag-danger">Listed before approval</span>`
    : "";

  return `
    <article class="process-row process-${escapeAttribute(entry.returnStatus)}">
      <div class="process-return-cell">
        <span class="process-return-label">${escapeHtml(entry.returnLabel)}</span>
        <strong>${escapeHtml(entry.returnValue)}</strong>
        <small>${escapeHtml(entry.returnDetail)}</small>
      </div>

      <div class="process-unit-cell">
        <strong class="process-product-name">${escapeHtml(productName)}</strong>
        <span class="process-order-number">Order ${escapeHtml(orderNumber)}</span>
        <span class="process-order-date">Ordered ${escapeHtml(row.orderDate || "date missing")}</span>
      </div>

      <div class="process-party-cell">
        <strong>${escapeHtml(row.seller || "Seller missing")}</strong>
        <span>${escapeHtml(row.account || "Account missing")}</span>
        ${row.reviewPolicy ? `<small>${escapeHtml(row.reviewPolicy)}</small>` : ""}
      </div>

      <div class="process-step-cell">
        <span class="process-stage stage-${escapeAttribute(entry.stageKey)}">${escapeHtml(entry.stageLabel)}</span>
        <strong>${escapeHtml(entry.nextStep)}</strong>
        ${trustedLabel}
        ${earlyListingLabel}
      </div>

      <div class="process-money-cell">
        <span>Item <strong>${escapeHtml(row.itemPrice || "-")}</strong></span>
        <span>Refund <strong>${escapeHtml(row.paidAmount || "-")}</strong></span>
        <span class="process-listing-state ${row.listed ? "is-listed" : ""}">
          ${row.listed ? "Listed" : "Not listed"}
        </span>
      </div>

      <details class="process-row-details">
        <summary>View all order fields</summary>
        <dl class="process-detail-grid">
          ${detailItem("Archive / paid", row.archived ? "Yes" : "No")}
          ${detailItem("Listed", row.listed ? "Yes" : "No")}
          ${detailItem("Seller", row.seller)}
          ${detailItem("Account", row.account)}
          ${detailItem("Product name", row.productName)}
          ${detailItem("Special double check", row.specialDoubleCheck ? "Yes" : "No")}
          ${detailItem("Order number", row.orderNumber)}
          ${detailItem("Order date", row.orderDate)}
          ${detailItem("Estimated return day", entry.returnDate ? formatDate(entry.returnDate) : "")}
          ${detailItem("Tracking", row.tracking)}
          ${detailItem("Review policy", row.reviewPolicy)}
          ${detailItem("Review submitted", row.reviewSubmitted)}
          ${detailItem("Review approved", row.reviewApproved)}
          ${detailItem("Item price with tax", row.itemPrice)}
          ${detailItem("Seller paid back", row.paidAmount)}
          ${detailItem("Pay method", row.payMethod)}
          ${detailItem("Payment day", row.paymentDay)}
          ${detailItem("Review / notes", row.reviewNotes)}
          ${detailItem("Source row", row.sheetRow ? String(row.sheetRow) : "")}
        </dl>
      </details>
    </article>
  `;
}

function detailItem(label, value) {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value || "-")}</dd>
    </div>
  `;
}

function bindPageEvents() {
  document.querySelector("#process-refresh-button")?.addEventListener("click", refreshProcess);
  document.querySelector("#process-retry-button")?.addEventListener("click", loadCurrentProcess);
  document.querySelector("#process-current-button")?.addEventListener("click", loadCurrentProcess);

  document.querySelectorAll("[data-process-scope]").forEach((button) => {
    button.addEventListener("click", () => {
      processState.scope = button.dataset.processScope || "active";
      renderPage();
    });
  });

  document.querySelector("#process-search")?.addEventListener("input", (event) => {
    processState.query = event.target.value;
    renderPage();
    window.requestAnimationFrame(() => {
      const input = document.querySelector("#process-search");
      input?.focus();
      input?.setSelectionRange(processState.query.length, processState.query.length);
    });
  });

  document.querySelector("#process-seller")?.addEventListener("change", (event) => {
    processState.seller = event.target.value;
    renderPage();
  });

  document.querySelector("#process-history-select")?.addEventListener("change", async (event) => {
    const snapshotId = event.target.value;
    if (snapshotId === "current") {
      await loadCurrentProcess();
      return;
    }
    await loadProcessSnapshot(snapshotId);
  });
}

async function loadCurrentProcess() {
  processState.loading = true;
  processState.error = "";
  processState.notice = "";
  renderPage();

  try {
    const [payload, snapshots] = await Promise.all([
      loadOrderProcessState(),
      loadOrderProcessHistory(),
    ]);
    processState.rows = Array.isArray(payload.rows) ? payload.rows : [];
    processState.meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
    processState.snapshots = snapshots;
    processState.snapshot = null;
    processState.loaded = true;
  } catch (error) {
    processState.error = error?.message || String(error);
  } finally {
    processState.loading = false;
    renderPage();
  }
}

async function loadProcessSnapshot(snapshotId) {
  processState.loading = true;
  processState.error = "";
  renderPage();

  try {
    const payload = await loadOrderProcessHistoryState(snapshotId);
    processState.rows = Array.isArray(payload.rows) ? payload.rows : [];
    processState.meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
    processState.snapshot = payload.snapshot || null;
    processState.loaded = true;
    processState.notice = "Historical process snapshots are read-only.";
  } catch (error) {
    processState.error = error?.message || String(error);
  } finally {
    processState.loading = false;
    renderPage();
  }
}

async function refreshProcess() {
  if (processState.snapshot?.id || processState.refreshing) {
    return;
  }

  processState.refreshing = true;
  processState.notice = "Refreshing the order process from Google Sheet...";
  renderPage();

  try {
    const result = await refreshOrderProcessSheet();
    const [payload, snapshots] = await Promise.all([
      loadOrderProcessState(),
      loadOrderProcessHistory(),
    ]);
    processState.rows = Array.isArray(payload.rows) ? payload.rows : [];
    processState.meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
    processState.snapshots = snapshots;
    processState.snapshot = null;
    processState.loaded = true;
    processState.error = "";
    processState.notice = `Refreshed ${result.rowCount || processState.rows.length} order rows.`;
  } catch (error) {
    processState.error = error?.message || String(error);
    processState.notice = "";
  } finally {
    processState.refreshing = false;
    renderPage();
  }
}

function analyzeProcessRow(row) {
  const today = startOfToday();
  const orderDate = parseSheetDate(row.orderDate);
  const returnWindowDays =
    Number(processState.meta.returnWindowDays) || DEFAULT_RETURN_WINDOW_DAYS;
  const returnDate = orderDate ? addDays(orderDate, returnWindowDays) : null;
  const daysRemaining = returnDate ? Math.round((returnDate.getTime() - today.getTime()) / DAY_MS) : null;
  const reviewProtected = Boolean(String(row.reviewSubmitted || "").trim() || String(row.reviewApproved || "").trim());
  const paidBack = Boolean(String(row.paidAmount || "").trim() || String(row.paymentDay || "").trim());
  const approved = Boolean(String(row.reviewApproved || "").trim());
  const submitted = Boolean(String(row.reviewSubmitted || "").trim());
  const trustedSeller = String(row.seller || "").trim().toLowerCase() === "tin";
  const trustedException = !row.archived && row.listed && !approved && trustedSeller;
  const earlyListingIssue = !row.archived && row.listed && !approved && !trustedSeller;

  let returnStatus = "safe";
  let returnLabel = "Return protected";
  let returnValue = reviewProtected ? "Review filed" : "Complete";
  let returnDetail = reviewProtected
    ? `Submitted ${row.reviewSubmitted || row.reviewApproved}`
    : "Refund received";

  if (!row.archived && !reviewProtected) {
    if (!returnDate) {
      returnStatus = "missing";
      returnLabel = "Date missing";
      returnValue = "No deadline";
      returnDetail = "Add the order date in the sheet";
    } else if (daysRemaining < 0) {
      returnStatus = "overdue";
      returnLabel = "Overdue";
      returnValue = `${Math.abs(daysRemaining)} day${Math.abs(daysRemaining) === 1 ? "" : "s"}`;
      returnDetail = `Return day was ${formatDate(returnDate)}`;
    } else if (daysRemaining <= 3) {
      returnStatus = "urgent";
      returnLabel = "Urgent";
      returnValue = daysRemaining === 0 ? "Due today" : `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`;
      returnDetail = `Return by ${formatDate(returnDate)}`;
    } else if (daysRemaining <= 7) {
      returnStatus = "due-soon";
      returnLabel = "Due soon";
      returnValue = `${daysRemaining} days left`;
      returnDetail = `Return by ${formatDate(returnDate)}`;
    } else if (daysRemaining <= 14) {
      returnStatus = "watch";
      returnLabel = "Watch";
      returnValue = `${daysRemaining} days left`;
      returnDetail = `Return by ${formatDate(returnDate)}`;
    } else {
      returnStatus = "on-track";
      returnLabel = "On track";
      returnValue = `${daysRemaining} days left`;
      returnDetail = `Return by ${formatDate(returnDate)}`;
    }
  }

  let stageKey = "review";
  let stageLabel = "Review needed";
  let nextStep = "Submit the required review";
  if (row.archived) {
    stageKey = "complete";
    stageLabel = "Paid and archived";
    nextStep = "Process complete";
  } else if (paidBack) {
    stageKey = "archive";
    stageLabel = "Refund received";
    nextStep = "Confirm payment and archive";
  } else if (approved) {
    stageKey = "refund";
    stageLabel = "Review approved";
    nextStep = "Send approval to seller for refund";
  } else if (submitted) {
    stageKey = "approval";
    stageLabel = "Review submitted";
    nextStep = "Wait for platform approval";
  } else if (!orderDate) {
    stageKey = "data";
    stageLabel = "Missing order date";
    nextStep = "Add order date before deadline tracking";
  }

  let priority = 9;
  if (returnStatus === "overdue") priority = 0;
  else if (returnStatus === "urgent") priority = 1;
  else if (returnStatus === "due-soon") priority = 2;
  else if (stageKey === "archive") priority = 3;
  else if (stageKey === "refund") priority = 4;
  else if (earlyListingIssue) priority = 5;
  else if (returnStatus === "watch") priority = 6;
  else if (stageKey === "approval") priority = 7;
  else if (returnStatus === "on-track") priority = 8;
  else if (row.archived) priority = 20;

  return {
    row,
    orderDate,
    returnDate,
    daysRemaining,
    reviewProtected,
    paidBack,
    approved,
    submitted,
    trustedException,
    earlyListingIssue,
    returnStatus,
    returnLabel,
    returnValue,
    returnDetail,
    stageKey,
    stageLabel,
    nextStep,
    priority,
  };
}

function buildProcessMetrics(rows) {
  const active = rows.filter((entry) => !entry.row.archived);
  return {
    total: rows.length,
    active: active.length,
    completed: rows.length - active.length,
    overdue: active.filter((entry) => entry.returnStatus === "overdue").length,
    dueSoon: active.filter(
      (entry) => entry.daysRemaining != null && entry.daysRemaining >= 0 && entry.daysRemaining <= 7 && !entry.reviewProtected,
    ).length,
    returnRisk: active.filter((entry) => !entry.reviewProtected).length,
    refunds: active.filter((entry) => ["approval", "refund", "archive"].includes(entry.stageKey)).length,
    exceptions: active.filter((entry) => entry.trustedException || entry.earlyListingIssue).length,
    trustedExceptions: active.filter((entry) => entry.trustedException).length,
    reviewProtected: active.filter((entry) => entry.reviewProtected).length,
  };
}

function filterProcessRows(rows) {
  const term = processState.query.trim().toLowerCase();
  return rows.filter((entry) => {
    if (processState.scope === "active" && entry.row.archived) return false;
    if (processState.scope === "return-risk" && (entry.row.archived || entry.reviewProtected)) return false;
    if (
      processState.scope === "refunds" &&
      (entry.row.archived || !["approval", "refund", "archive"].includes(entry.stageKey))
    ) {
      return false;
    }
    if (
      processState.scope === "exceptions" &&
      !entry.trustedException &&
      !entry.earlyListingIssue
    ) {
      return false;
    }
    if (processState.scope === "completed" && !entry.row.archived) return false;
    if (processState.seller !== "all" && entry.row.seller !== processState.seller) return false;
    if (!term) return true;

    return [
      entry.row.productName,
      entry.row.orderNumber,
      entry.row.seller,
      entry.row.account,
      entry.row.tracking,
      entry.row.reviewPolicy,
      entry.row.reviewNotes,
    ]
      .join(" ")
      .toLowerCase()
      .includes(term);
  });
}

function compareProcessRows(left, right) {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  const leftReturn = left.returnDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightReturn = right.returnDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftReturn !== rightReturn) {
    return leftReturn - rightReturn;
  }
  return (right.orderDate?.getTime() || 0) - (left.orderDate?.getTime() || 0);
}

function parseSheetDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    const date = new Date(year, Number(match[1]) - 1, Number(match[2]));
    if (
      date.getFullYear() === year &&
      date.getMonth() === Number(match[1]) - 1 &&
      date.getDate() === Number(match[2])
    ) {
      return date;
    }
  }

  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }

  return null;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function formatDate(value) {
  return value.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatSnapshotOption(snapshot) {
  const label = snapshot.label || "Order process refresh";
  return `${formatDateTime(snapshot.createdAt)} - ${label} - ${snapshot.rowCount || 0} rows`;
}

function googleSheetPageUrl(value) {
  const match = String(value || "").match(
    /^(https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+)/i,
  );
  return match ? `${match[1]}/edit?usp=sharing` : "";
}

function isProcessRoute() {
  const basePath = pageContext?.basePath || "";
  const pathname = window.location.pathname.replace(/\/+$/, "");
  return pathname === `${basePath}/process`.replace(/\/+$/, "");
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

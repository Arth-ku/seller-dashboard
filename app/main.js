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
import { loadAppState, saveAppState, saveMeta, saveProductDetails, saveRows, uploadImages } from "./store.js";

const app = document.querySelector("#app");
const APP_CONFIG = window.__APP_CONFIG__ || {};
const BASE_PATH = normalizeBasePath(APP_CONFIG.basePath);
const DASHBOARD_COLUMNS = COLUMN_DEFS.filter(({ key }) =>
  ["boxId", "archived", "itemName"].includes(key),
);

const state = {
  rows: [],
  productDetails: {},
  meta: {},
  search: "",
  archiveFilter: "present",
  boxSort: "desc",
  saveMessage: "",
};

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
  const stored = await loadAppState();
  state.rows = pruneRows((stored.rows || []).map(normalizeRowState));
  state.productDetails = stored.productDetails;
  state.meta = stored.meta;

  if ((stored.rows || []).length !== state.rows.length) {
    await saveRows(state.rows);
  }

  render();
}

function render() {
  const route = getCurrentRoute();
  app.innerHTML = "";

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
  const imageCountText = `${detail.images.length}/9 images uploaded`;

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
          <span class="detail-pill">${escapeHtml(row?.priceListed || "No listed price")}</span>
          <span class="detail-pill">${escapeHtml(row?.soldThrough || "No sale platform")}</span>
        </div>
      </div>

      <div class="detail-layout">
        <div class="detail-column">
          <section class="subpanel">
            <div class="subpanel-heading">
              <h2>Photos</h2>
              <p>${escapeHtml(imageCountText)}</p>
            </div>
            <label class="upload-zone">
              <input id="image-input" type="file" accept=".webp,.jpg,.jpeg,.png,.gif,.avif,.bmp,.svg,image/webp,image/jpeg,image/png,image/gif,image/avif,image/bmp,image/svg+xml" multiple />
              <span>Upload up to 9 images</span>
              <small>Photos are stored on the server so every device can see them. Supports webp, jpg, jpeg, png, gif, avif, bmp, and svg.</small>
            </label>
            <div class="image-grid">
              ${
                detail.images.length
                  ? detail.images
                      .map(
                        (image, index) => `
                          <figure class="image-card">
                            <img src="${escapeAttribute(getImageSource(image))}" alt="${escapeAttribute(image.name || `Image ${index + 1}`)}" />
                            <figcaption>
                              <span>${escapeHtml(image.name || `Image ${index + 1}`)}</span>
                              <div class="image-actions">
                                <button class="button-link" type="button" data-move-image="${index}" data-direction="left" ${index === 0 ? "disabled" : ""}>Left</button>
                                <button class="button-link" type="button" data-move-image="${index}" data-direction="right" ${index === detail.images.length - 1 ? "disabled" : ""}>Right</button>
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
                        <a class="authenticity-image-link" href="${escapeAttribute(getImageSource(image))}" target="_blank" rel="noopener noreferrer">
                          <img src="${escapeAttribute(getImageSource(image))}" alt="${escapeAttribute(image.name || `Image ${index + 1}`)}" />
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

  csvInput?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

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

    const current = collectDetailDraft(boxId);
    const remainingSlots = Math.max(0, 9 - current.images.length);
    const nextFiles = files.slice(0, remainingSlots);
    const uploaded = await uploadImages(boxId, nextFiles);

    current.images = current.images.concat(uploaded);
    current.updatedAt = new Date().toISOString();
    state.productDetails[boxId] = current;
    await saveProductDetails(state.productDetails);
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

  document.querySelectorAll("[data-move-image]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const index = Number(event.currentTarget.dataset.moveImage);
      const direction = event.currentTarget.dataset.direction;
      const current = collectDetailDraft(boxId);
      const offset = direction === "left" ? -1 : 1;
      const nextIndex = index + offset;

      if (nextIndex < 0 || nextIndex >= current.images.length) {
        return;
      }

      const reordered = [...current.images];
      const [selected] = reordered.splice(index, 1);
      reordered.splice(nextIndex, 0, selected);
      current.images = reordered;
      current.updatedAt = new Date().toISOString();
      state.productDetails[boxId] = current;
      await saveProductDetails(state.productDetails);
      render();
    });
  });
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

  return {
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

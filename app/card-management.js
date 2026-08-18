const DEFAULT_START_DATE = "2026-06-11";

const DEFAULT_CARDS = [
  { id: "amazon-1045", name: "Amazon", last4: "1045", color: "#1747c9", active: true },
  { id: "sapphire-0185", name: "Sapphire", last4: "0185", color: "#315dba", active: true },
  { id: "ms-5276", name: "MS", last4: "5276", color: "#5577cf", active: true },
  { id: "discover-3038", name: "Discover", last4: "3038", color: "#758fd8", active: true },
  { id: "chase-debit-3383", name: "Chase Debit", last4: "3383", color: "#96a9df", active: true },
  { id: "apple-7190", name: "Apple", last4: "7190", color: "#b6c3e7", active: true },
];

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function normalizeCardManagement(value) {
  const source = value && typeof value === "object" ? value : {};
  const transactions = Array.isArray(source.transactions) ? source.transactions : [];
  return {
    cards: Array.isArray(source.cards) && source.cards.length ? source.cards : DEFAULT_CARDS,
    transactions,
    statementImports: normalizeStatementImports(source.statementImports, transactions),
    startDate: source.startDate || DEFAULT_START_DATE,
  };
}

export function renderCardManagement(root, options) {
  let model = normalizeCardManagement(options.value);
  const ui = {
    startDate: model.startDate,
    search: "",
    card: "all",
    status: "all",
    purchaseType: "all",
    sort: "newest",
    endDate: isoToday(),
    editingId: "",
  };

  const render = () => {
    const visible = getVisibleTransactions(model.transactions, ui);
    const purchaseScope = getVisibleTransactions(model.transactions, { ...ui, purchaseType: "all" });
    const purchaseBreakdown = summarizePurchaseTypes(purchaseScope);
    const activity = summarizeActivity(visible);
    const summary = summarize(visible);
    const exposure = buildExposure(model.cards, visible);
    const maxExposure = Math.max(1, ...exposure.map((entry) => entry.amount));
    const hasFilters = Boolean(ui.search || ui.card !== "all" || ui.status !== "all" || ui.purchaseType !== "all");

    root.innerHTML = `
      <main class="card-shell">
        ${buildNavigation(options)}
        <header class="card-page-header">
          <div>
            <h1>Card Management</h1>
            <p>Control Amazon holds, confirm statement matches, and keep card activity review-ready.</p>
          </div>
          <div class="date-controls" aria-label="Reporting period">
            <label>Start<input id="card-start-date" type="date" value="${escapeAttribute(model.startDate)}" /></label>
            <label>End<input id="card-end-date" type="date" value="${escapeAttribute(ui.endDate)}" /></label>
          </div>
        </header>

        <section class="card-kpis" aria-label="Card management summary">
          ${metricCard("Amazon money held", summary.amazonHeld, "Across active card holds", "blue")}
          ${metricCard("Unmatched charges", summary.unmatchedAmount, `${summary.unmatchedCount} transaction${summary.unmatchedCount === 1 ? "" : "s"}`, "red")}
          ${metricCard("Refunds pending", summary.refundsPending, `${summary.refundCount} refund${summary.refundCount === 1 ? "" : "s"}`, "amber")}
          ${metricCard("Confirmed spend", summary.confirmedSpend, `${summary.confirmedCount} confirmed charge${summary.confirmedCount === 1 ? "" : "s"}`, "green")}
        </section>

        <section class="card-overview-grid">
          <article class="finance-panel exposure-panel">
            <div class="finance-heading">
              <div>
                <h2>Amazon holds by card</h2>
                <p>Orders marked as held and not yet released or refunded.</p>
              </div>
              <strong>${money.format(summary.amazonHeld)}</strong>
            </div>
            <div class="exposure-list">
              ${exposure.map((entry) => exposureRow(entry, maxExposure)).join("")}
            </div>
          </article>
          <article class="finance-panel review-panel">
            <div class="finance-heading">
              <div>
                <h2>Review queue</h2>
                <p>Work the exceptions first.</p>
              </div>
              <span class="queue-count">${summary.reviewCount}</span>
            </div>
            ${reviewQueue(summary)}
          </article>
        </section>

        <section class="finance-panel transaction-panel">
          <div class="transaction-heading">
            <div>
              <h2>Transactions</h2>
              <p>Separate business-related Amazon purchases from every other bill.</p>
            </div>
            <span>${visible.length} shown</span>
          </div>
          <div class="purchase-type-filter" role="group" aria-label="Filter by purchase type">
            ${purchaseTypeButton("all", "All activity", "Amazon and other bills", purchaseBreakdown.all, ui.purchaseType)}
            ${purchaseTypeButton("amazon", "Amazon purchases", "Business only", purchaseBreakdown.amazon, ui.purchaseType)}
            ${purchaseTypeButton("other", "Other bills", "Non-Amazon activity", purchaseBreakdown.other, ui.purchaseType)}
          </div>
          <div class="transaction-toolbar">
            <div class="transaction-filters">
              <label class="finance-search">
                <span class="sr-only">Search transactions</span>
                <input id="card-search" type="search" value="${escapeAttribute(ui.search)}" placeholder="Search merchant, order, card, or note…" />
              </label>
              <label>
                <span class="sr-only">Card</span>
                <select id="card-filter">
                  <option value="all">All cards</option>
                  ${model.cards.map((card) => `<option value="${escapeAttribute(card.id)}" ${ui.card === card.id ? "selected" : ""}>${escapeHtml(cardLabel(card))}</option>`).join("")}
                </select>
              </label>
              <label>
                <span class="sr-only">Status</span>
                <select id="status-filter">
                  <option value="all">All statuses</option>
                  ${["held", "unmatched", "review", "confirmed", "refund-pending", "released"].map((status) => `<option value="${status}" ${ui.status === status ? "selected" : ""}>${escapeHtml(statusLabel(status))}</option>`).join("")}
                </select>
              </label>
              <label>
                <span class="sr-only">Sort transactions</span>
                <select id="transaction-sort">
                  <option value="newest" ${ui.sort === "newest" ? "selected" : ""}>Newest first</option>
                  <option value="oldest" ${ui.sort === "oldest" ? "selected" : ""}>Oldest first</option>
                  <option value="amount-high" ${ui.sort === "amount-high" ? "selected" : ""}>Largest amount</option>
                  <option value="amount-low" ${ui.sort === "amount-low" ? "selected" : ""}>Smallest amount</option>
                </select>
              </label>
              ${hasFilters ? `<button id="clear-card-filters" class="clear-finance-filters" type="button">Clear filters</button>` : ""}
            </div>
            <div class="transaction-actions">
              <label class="finance-button secondary statement-import-button">
                <input id="card-statement-import" type="file" accept=".csv,text/csv" multiple />
                Import statements
              </label>
              <button id="export-card-csv" class="finance-button secondary" type="button">Export CSV</button>
              <button id="add-card-transaction" class="finance-button primary" type="button">Add transaction</button>
            </div>
          </div>
          ${statementImportHistory(model.statementImports, model.cards)}
          <div class="transaction-summary" aria-label="Totals for the current transaction view">
            ${activityMetric("Transactions", String(activity.count), "Current filtered view")}
            ${activityMetric("Purchases", money.format(activity.charges), `${activity.chargeCount} charge${activity.chargeCount === 1 ? "" : "s"}`, "charge")}
            ${activityMetric("Refunds & credits", money.format(activity.credits), `${activity.creditCount} credit${activity.creditCount === 1 ? "" : "s"}`, "credit")}
            ${activityMetric("Net activity", money.format(activity.net), activity.net >= 0 ? "Purchases minus credits" : "Credits exceed purchases", activity.net < 0 ? "credit" : "net")}
          </div>
          <div class="finance-table-wrap">
            ${transactionTable(visible, model.cards)}
          </div>
        </section>
      </main>
      ${ui.editingId ? editDrawer(model, ui.editingId) : ""}
    `;

    bindEvents();
  };

  const persist = async (message) => {
    await options.onSave(model);
    options.onMessage?.(message);
  };

  const bindEvents = () => {
    root.querySelectorAll("[data-route]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        options.onNavigate(link.getAttribute("href"));
      });
    });

    bindValue("#card-start-date", "change", async (value) => {
      model.startDate = value || DEFAULT_START_DATE;
      ui.startDate = model.startDate;
      await persist("Card reporting start date saved.");
      render();
    });
    bindValue("#card-end-date", "change", (value) => {
      ui.endDate = value || isoToday();
      render();
    });
    bindValue("#card-search", "input", (value) => {
      ui.search = value;
      render();
      requestAnimationFrame(() => {
        const input = root.querySelector("#card-search");
        input?.focus();
        input?.setSelectionRange(ui.search.length, ui.search.length);
      });
    });
    bindValue("#card-filter", "change", (value) => {
      ui.card = value;
      render();
    });
    bindValue("#status-filter", "change", (value) => {
      ui.status = value;
      render();
    });
    bindValue("#transaction-sort", "change", (value) => {
      ui.sort = value;
      render();
    });
    root.querySelectorAll("[data-purchase-type]").forEach((button) => {
      button.addEventListener("click", () => {
        ui.purchaseType = button.dataset.purchaseType;
        render();
      });
    });
    root.querySelector("#clear-card-filters")?.addEventListener("click", () => {
      ui.search = "";
      ui.card = "all";
      ui.status = "all";
      ui.purchaseType = "all";
      render();
    });
    root.querySelector("#add-card-transaction")?.addEventListener("click", () => {
      ui.editingId = "new";
      render();
    });
    root.querySelector("#export-card-csv")?.addEventListener("click", () => exportCsv(visible, model.cards));
    root.querySelector("#card-statement-import")?.addEventListener("change", async (event) => {
      const files = Array.from(event.target.files || []);
      if (!files.length) return;
      const imported = [];
      const importRecords = [];
      const errors = [];
      const existingKeys = new Set(model.transactions.map(transactionKey));
      for (const file of files) {
        const importedAt = new Date().toISOString();
        try {
          const parsed = transactionsFromStatement(await file.text(), file.name, model.cards, model.startDate)
            .map((entry) => ({ ...entry, statementFileName: file.name }));
          let addedCount = 0;
          parsed.forEach((entry) => {
            const key = transactionKey(entry);
            if (existingKeys.has(key)) return;
            existingKeys.add(key);
            imported.push(entry);
            addedCount += 1;
          });
          importRecords.push({
            id: statementImportId(file.name, file.size, file.lastModified),
            fileName: file.name,
            cardId: parsed[0]?.cardId || inferCardFromFileName(file.name, model.cards)?.id || "",
            fileSize: Number(file.size) || 0,
            fileLastModified: Number(file.lastModified) || 0,
            importedAt,
            parsedCount: parsed.length,
            addedCount,
            duplicateCount: parsed.length - addedCount,
            inferred: false,
            error: "",
          });
        } catch (error) {
          errors.push(`${file.name}: ${error.message}`);
          importRecords.push({
            id: statementImportId(file.name, file.size, file.lastModified),
            fileName: file.name,
            fileSize: Number(file.size) || 0,
            fileLastModified: Number(file.lastModified) || 0,
            importedAt,
            parsedCount: 0,
            addedCount: 0,
            duplicateCount: 0,
            inferred: false,
            error: error.message,
          });
        }
      }
      model.transactions = [...imported, ...model.transactions];
      model.statementImports = mergeStatementImports(model.statementImports, importRecords, model.transactions);
      await persist(`Imported ${imported.length} new transaction${imported.length === 1 ? "" : "s"} from ${files.length} CSV file${files.length === 1 ? "" : "s"}${errors.length ? `; ${errors.length} file(s) need review` : ""}.`);
      render();
    });
    root.querySelector("[data-close-card-drawer]")?.addEventListener("click", () => {
      ui.editingId = "";
      render();
    });
    root.querySelector("#cancel-card-edit")?.addEventListener("click", () => {
      ui.editingId = "";
      render();
    });
    root.querySelector("#card-transaction-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const transaction = transactionFromForm(new FormData(event.currentTarget), ui.editingId);
      const existingIndex = model.transactions.findIndex((entry) => entry.id === transaction.id);
      if (existingIndex >= 0) {
        model.transactions[existingIndex] = transaction;
      } else {
        model.transactions = [transaction, ...model.transactions];
      }
      ui.editingId = "";
      await persist("Card transaction saved.");
      render();
    });
    root.querySelector("#delete-card-transaction")?.addEventListener("click", async () => {
      model.transactions = model.transactions.filter((entry) => entry.id !== ui.editingId);
      ui.editingId = "";
      await persist("Card transaction deleted.");
      render();
    });

    root.querySelectorAll("[data-edit-transaction]").forEach((button) => {
      button.addEventListener("click", () => {
        ui.editingId = button.dataset.editTransaction;
        render();
      });
    });
    root.querySelectorAll("[data-confirm-transaction]").forEach((button) => {
      button.addEventListener("click", async () => {
        updateTransaction(button.dataset.confirmTransaction, { status: "confirmed", confidence: 100 });
        await persist("Transaction confirmed.");
        render();
      });
    });
    root.querySelectorAll("[data-flag-transaction]").forEach((button) => {
      button.addEventListener("click", async () => {
        updateTransaction(button.dataset.flagTransaction, { status: "review" });
        await persist("Transaction moved to review.");
        render();
      });
    });
  };

  function bindValue(selector, eventName, handler) {
    root.querySelector(selector)?.addEventListener(eventName, (event) => handler(event.target.value));
  }

  function updateTransaction(id, changes) {
    model.transactions = model.transactions.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry));
  }

  render();
}

function buildNavigation(options) {
  return `
    <nav class="dashboard-nav" aria-label="Seller dashboard sections">
      <a data-route href="${escapeAttribute(options.inventoryPath)}">Inventory</a>
      <a class="active" data-route href="${escapeAttribute(options.cardPath)}">Card Management</a>
    </nav>
  `;
}

function metricCard(label, amount, detail, tone) {
  return `
    <article class="card-kpi ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${money.format(amount)}</strong>
      <small>${escapeHtml(detail)}</small>
    </article>
  `;
}

function purchaseTypeButton(value, label, detail, summary, activeValue) {
  return `
    <button class="purchase-type-option ${activeValue === value ? "active" : ""}" type="button" data-purchase-type="${value}" aria-pressed="${activeValue === value}">
      <span><b>${escapeHtml(label)}</b><small>${escapeHtml(detail)}</small></span>
      <strong>${summary.count}</strong>
      <em>${summary.chargeCount} purchase${summary.chargeCount === 1 ? "" : "s"} · ${money.format(summary.charges)}</em>
    </button>
  `;
}

function activityMetric(label, value, detail, tone = "") {
  return `
    <div class="transaction-summary-item ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  `;
}

function statementImportHistory(imports, cards) {
  if (!imports.length) {
    return `
      <div class="statement-history empty">
        <div><strong>Uploaded CSV files</strong><span>No statement files remembered yet.</span></div>
        <small>Imported filenames and results will stay here after refresh.</small>
      </div>
    `;
  }

  const cardById = new Map(cards.map((card) => [card.id, cardLabel(card)]));
  return `
    <details class="statement-history" open>
      <summary>
        <span><strong>Uploaded CSV files</strong><small>${imports.length} file${imports.length === 1 ? "" : "s"} remembered</small></span>
        <b>Import history</b>
      </summary>
      <div class="statement-history-list">
        ${imports.map((entry) => statementImportRow(entry, cardById)).join("")}
      </div>
    </details>
  `;
}

function statementImportRow(entry, cardById) {
  const matchedCard = entry.cardId ? cardById.get(entry.cardId) : "";
  const added = Number(entry.addedCount) || 0;
  const duplicates = Number(entry.duplicateCount) || 0;
  const saved = Number(entry.savedTransactionCount) || 0;
  let result = entry.error
    ? `Needs review: ${entry.error}`
    : `${added} added${duplicates ? ` · ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped` : ""}`;
  if (entry.inferred) result = `${saved} saved transaction${saved === 1 ? "" : "s"} · recovered from earlier import`;

  return `
    <div class="statement-history-row ${entry.error ? "has-error" : ""}">
      <span class="statement-file-icon" aria-hidden="true">CSV</span>
      <span class="statement-file-name"><strong>${escapeHtml(entry.fileName)}</strong><small>${escapeHtml([matchedCard, formatImportDate(entry.importedAt)].filter(Boolean).join(" · ") || "Earlier import")}</small></span>
      <span class="statement-import-result">${escapeHtml(result)}</span>
    </div>
  `;
}

function exposureRow(entry, max) {
  const width = entry.amount > 0 ? Math.max(2, (entry.amount / max) * 100) : 0;
  return `
    <div class="exposure-row">
      <span>${escapeHtml(cardLabel(entry.card))}</span>
      <div class="exposure-track"><i style="width:${width}%;background:${escapeAttribute(entry.card.color || "#1747c9")}"></i></div>
      <strong>${money.format(entry.amount)}</strong>
    </div>
  `;
}

function reviewQueue(summary) {
  const items = [
    ["Unmatched charges", summary.unmatchedCount, summary.unmatchedAmount, "danger"],
    ["Needs review", summary.needsReviewCount, summary.needsReviewAmount, "warning"],
    ["Refunds pending", summary.refundCount, summary.refundsPending, "warning"],
    ["Amazon holds over 15 days", summary.oldHoldCount, summary.oldHoldAmount, "neutral"],
  ];
  return `<div class="review-list">${items.map(([label, count, amount, tone]) => `
    <div class="review-row ${tone}">
      <span><i></i>${escapeHtml(label)}</span>
      <b>${count}</b>
      <strong>${money.format(amount)}</strong>
    </div>`).join("")}</div>`;
}

function transactionTable(transactions, cards) {
  if (!transactions.length) {
    return `
      <div class="card-empty-state">
        <h2>No card transactions yet</h2>
        <p>Add the first charge or refund from June 11, 2026 onward. Mark Amazon orders as held to see exposure by card.</p>
        <p>Charges use positive amounts. Refunds use negative amounts.</p>
      </div>
    `;
  }

  const byId = new Map(cards.map((card) => [card.id, card]));
  return `
    <table class="finance-table">
      <thead><tr>
        <th>Transaction date</th><th>Order / evidence</th><th>Card</th><th>Merchant</th>
        <th class="number-cell">Amount</th><th>Confidence</th><th>Status</th><th>Actions</th>
      </tr></thead>
      <tbody>${transactions.map((entry) => {
        const card = byId.get(entry.cardId);
        return `<tr>
          <td>${formatDate(entry.transactionDate)}</td>
          <td><strong>${escapeHtml(entry.orderNumber || "—")}</strong><small>${escapeHtml(entry.orderDate ? formatDate(entry.orderDate) : entry.evidence || "No order evidence")}</small></td>
          <td>${escapeHtml(card ? cardLabel(card) : "Unknown card")}</td>
          <td><strong>${escapeHtml(entry.merchant || "—")}</strong><small class="purchase-classification ${entry.amazon ? "business" : "other"}">${escapeHtml(purchaseClassification(entry))}</small></td>
          <td class="number-cell ${Number(entry.amount) < 0 ? "refund-amount" : ""}">${money.format(Number(entry.amount) || 0)}</td>
          <td>${confidenceMarkup(entry.confidence)}</td>
          <td><span class="status-tag ${escapeAttribute(entry.status)}">${escapeHtml(statusLabel(entry.status))}</span></td>
          <td><div class="table-actions">
            <button type="button" title="Confirm match" data-confirm-transaction="${escapeAttribute(entry.id)}">✓</button>
            <button type="button" title="Flag for review" data-flag-transaction="${escapeAttribute(entry.id)}">⚑</button>
            <button type="button" title="Edit transaction" data-edit-transaction="${escapeAttribute(entry.id)}">Edit</button>
          </div></td>
        </tr>`;
      }).join("")}</tbody>
    </table>
  `;
}

function editDrawer(model, editingId) {
  const entry = editingId === "new"
    ? { id: "new", transactionDate: isoToday(), orderDate: "", cardId: model.cards[0]?.id || "", merchant: "Amazon", amount: "", status: "unmatched", confidence: 0, amazon: true, orderNumber: "", evidence: "", note: "" }
    : model.transactions.find((candidate) => candidate.id === editingId);
  if (!entry) return "";

  return `
    <div class="drawer-layer">
      <button class="drawer-backdrop" type="button" data-close-card-drawer aria-label="Close transaction editor"></button>
      <aside class="transaction-drawer" aria-label="${editingId === "new" ? "Add" : "Edit"} card transaction">
        <div class="drawer-heading">
          <div><h2>${editingId === "new" ? "Add transaction" : "Edit transaction"}</h2><p>Link the bank activity to the best available order evidence.</p></div>
          <button type="button" data-close-card-drawer aria-label="Close">×</button>
        </div>
        <form id="card-transaction-form">
          <div class="drawer-fields two-column">
            ${field("Transaction date", `<input name="transactionDate" type="date" required value="${escapeAttribute(entry.transactionDate)}" />`)}
            ${field("Order date", `<input name="orderDate" type="date" value="${escapeAttribute(entry.orderDate || "")}" />`)}
          </div>
          ${field("Card", `<select name="cardId" required>${model.cards.map((card) => `<option value="${escapeAttribute(card.id)}" ${entry.cardId === card.id ? "selected" : ""}>${escapeHtml(cardLabel(card))}</option>`).join("")}</select>`)}
          ${field("Merchant", `<input name="merchant" required value="${escapeAttribute(entry.merchant || "")}" placeholder="Amazon, Staples, airline…" />`)}
          ${field("Amount (USD)", `<input name="amount" type="number" step="0.01" required value="${escapeAttribute(entry.amount)}" placeholder="Positive charge or negative refund" />`)}
          ${field("Amazon order number", `<input name="orderNumber" value="${escapeAttribute(entry.orderNumber || "")}" placeholder="113-1234567-1234567" />`)}
          ${field("Other evidence", `<input name="evidence" value="${escapeAttribute(entry.evidence || "")}" placeholder="Posted date, tracking, statement note…" />`)}
          <div class="drawer-fields two-column">
            ${field("Status", `<select name="status">${["held", "unmatched", "review", "confirmed", "refund-pending", "released"].map((status) => `<option value="${status}" ${entry.status === status ? "selected" : ""}>${escapeHtml(statusLabel(status))}</option>`).join("")}</select>`)}
            ${field("Match confidence", `<input name="confidence" type="number" min="0" max="100" value="${escapeAttribute(entry.confidence ?? 0)}" />`)}
          </div>
          <label class="drawer-checkbox"><input name="amazon" type="checkbox" ${entry.amazon ? "checked" : ""} /> Amazon transaction</label>
          ${field("Notes", `<textarea name="note" rows="4" placeholder="Why it matches, what needs review, or when the hold should release…">${escapeHtml(entry.note || "")}</textarea>`)}
          <div class="drawer-actions">
            ${editingId === "new" ? "" : `<button id="delete-card-transaction" class="finance-button danger" type="button">Delete</button>`}
            <span class="drawer-action-spacer"></span>
            <button id="cancel-card-edit" class="finance-button secondary" type="button">Cancel</button>
            <button class="finance-button primary" type="submit">Save transaction</button>
          </div>
        </form>
      </aside>
    </div>
  `;
}

function field(label, control) {
  return `<label class="drawer-field"><span>${escapeHtml(label)}</span>${control}</label>`;
}

function transactionFromForm(form, editingId) {
  return {
    id: editingId === "new" ? `card-${Date.now()}-${Math.random().toString(16).slice(2)}` : editingId,
    transactionDate: String(form.get("transactionDate") || ""),
    orderDate: String(form.get("orderDate") || ""),
    cardId: String(form.get("cardId") || ""),
    merchant: String(form.get("merchant") || "").trim(),
    amount: Number(form.get("amount") || 0),
    orderNumber: String(form.get("orderNumber") || "").trim(),
    evidence: String(form.get("evidence") || "").trim(),
    status: String(form.get("status") || "unmatched"),
    confidence: Math.max(0, Math.min(100, Number(form.get("confidence") || 0))),
    amazon: form.get("amazon") === "on",
    note: String(form.get("note") || "").trim(),
    updatedAt: new Date().toISOString(),
  };
}

function transactionsFromStatement(text, fileName, cards, startDate) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((value) => value.trim());
  const records = rows.slice(1).filter((row) => row.some((value) => String(value).trim())).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, String(row[index] ?? "").trim()])),
  );
  const card = inferCardFromFileName(fileName, cards);
  if (!card) throw new Error("card number was not recognized in the filename");

  return records.flatMap((record, index) => {
    const transactionDate = normalizeStatementDate(
      record["Transaction Date"] || record["Trans. Date"] || record["Posting Date"],
    );
    if (!transactionDate || transactionDate < startDate) return [];

    const description = record.Description || record.Merchant || "";
    const rawType = record.Type || record.Details || record.Category || "";
    if (isAccountPayment(description, rawType)) return [];

    const sourceAmount = parseStatementAmount(record.Amount ?? record["Amount (USD)"]);
    if (!Number.isFinite(sourceAmount) || sourceAmount === 0) return [];
    const amount = normalizeStatementAmount(sourceAmount, record, fileName);
    const amazon = /\bAMAZON\b|\bAMZN\b/i.test(`${description} ${record.Merchant || ""}`);
    const isRefund = amount < 0;
    const status = isRefund ? "refund-pending" : amazon ? "held" : "unmatched";
    const confidence = amazon ? 85 : 35;

    return [{
      id: `import-${card.id}-${transactionDate}-${Math.abs(amount).toFixed(2)}-${stableHash(`${description}-${index}`)}`,
      transactionDate,
      orderDate: "",
      cardId: card.id,
      merchant: description || record.Merchant || "Statement transaction",
      amount,
      orderNumber: "",
      evidence: record["Post Date"] || record["Clearing Date"] || record["Posting Date"] || rawType,
      status,
      confidence,
      amazon,
      note: `Imported from ${fileName}`,
      updatedAt: new Date().toISOString(),
    }];
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function inferCardFromFileName(fileName, cards) {
  const aliases = { "7560": "chase-debit-3383" };
  const aliasId = Object.entries(aliases).find(([last4]) => fileName.includes(last4))?.[1];
  return cards.find((card) => card.id === aliasId || fileName.includes(card.last4));
}

function normalizeStatementDate(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : "";
}

function parseStatementAmount(value) {
  const number = Number(String(value ?? "").replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
  return Number.isFinite(number) ? number : Number.NaN;
}

function normalizeStatementAmount(amount, record, fileName) {
  if (/Apple Card/i.test(fileName)) {
    return /refund|credit|return/i.test(`${record.Type || ""} ${record.Description || ""}`) ? -Math.abs(amount) : Math.abs(amount);
  }
  if (/Discover/i.test(fileName)) return amount;
  if (/Chase7560/i.test(fileName)) return /DEBIT/i.test(record.Details || "") ? Math.abs(amount) : -Math.abs(amount);
  return amount < 0 ? Math.abs(amount) : -Math.abs(amount);
}

function isAccountPayment(description, type) {
  return /PAYMENT.+THANK|AUTOMATIC PAYMENT|INTERNET PAYMENT|MOBILE PAYMENT|PAYMENT RECEIVED/i.test(`${description} ${type}`);
}

function transactionKey(entry) {
  return [entry.transactionDate, entry.cardId, Number(entry.amount).toFixed(2), String(entry.merchant || "").toUpperCase()].join("|");
}

function normalizeStatementImports(value, transactions) {
  const stored = Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === "object" && entry.fileName).map((entry) => ({ ...entry }))
    : [];
  return mergeStatementImports([], stored, transactions);
}

function mergeStatementImports(current, incoming, transactions) {
  const byIdentity = new Map();
  [...current, ...incoming].forEach((entry) => {
    if (!entry?.fileName) return;
    const identity = String(entry.fileName).toLowerCase();
    const previous = byIdentity.get(identity);
    byIdentity.set(identity, previous ? {
      ...previous,
      ...entry,
      firstImportedAt: previous.firstImportedAt || previous.importedAt || entry.importedAt,
      uploadCount: (Number(previous.uploadCount) || 1) + 1,
    } : {
      ...entry,
      firstImportedAt: entry.firstImportedAt || entry.importedAt || "",
      uploadCount: Number(entry.uploadCount) || 1,
    });
  });

  const transactionFiles = new Map();
  transactions.forEach((entry) => {
    const fileName = statementFileName(entry);
    if (!fileName) return;
    const key = fileName.toLowerCase();
    const existing = transactionFiles.get(key) || { fileName, count: 0, latestAt: "", cardId: entry.cardId || "" };
    existing.count += 1;
    existing.latestAt = String(entry.updatedAt || "") > existing.latestAt ? String(entry.updatedAt || "") : existing.latestAt;
    existing.cardId ||= entry.cardId || "";
    transactionFiles.set(key, existing);
  });

  transactionFiles.forEach((details, fileNameKey) => {
    const existingKey = Array.from(byIdentity.keys()).find((key) => {
      const entry = byIdentity.get(key);
      return String(entry.fileName).toLowerCase() === fileNameKey;
    });
    if (existingKey) {
      byIdentity.set(existingKey, { ...byIdentity.get(existingKey), savedTransactionCount: details.count, cardId: byIdentity.get(existingKey).cardId || details.cardId });
      return;
    }
    const fileName = details.fileName;
    const identity = `inferred-${stableHash(fileNameKey)}`;
    byIdentity.set(identity, {
      id: identity,
      fileName,
      importedAt: details.latestAt,
      firstImportedAt: details.latestAt,
      parsedCount: details.count,
      addedCount: details.count,
      duplicateCount: 0,
      savedTransactionCount: details.count,
      cardId: details.cardId,
      uploadCount: 1,
      inferred: true,
      error: "",
    });
  });

  return Array.from(byIdentity.values()).sort((left, right) => String(right.importedAt || "").localeCompare(String(left.importedAt || "")));
}

function statementFileName(entry) {
  if (entry?.statementFileName) return String(entry.statementFileName);
  const note = String(entry?.note || "");
  return note.startsWith("Imported from ") ? note.slice("Imported from ".length).trim() : "";
}

function statementImportId(fileName, size, lastModified) {
  return `statement-${stableHash(`${fileName}|${Number(size) || 0}|${Number(lastModified) || 0}`)}`;
}

function stableHash(value) {
  let hash = 0;
  for (const char of String(value)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}

function getVisibleTransactions(transactions, ui) {
  const from = ui.startDate || DEFAULT_START_DATE;
  const term = ui.search.trim().toLowerCase();
  return transactions
    .filter((entry) => {
      if (entry.transactionDate && entry.transactionDate < from) return false;
      if (entry.transactionDate && entry.transactionDate > ui.endDate) return false;
      if (ui.card !== "all" && entry.cardId !== ui.card) return false;
      if (ui.status !== "all" && entry.status !== ui.status) return false;
      if (ui.purchaseType === "amazon" && !entry.amazon) return false;
      if (ui.purchaseType === "other" && entry.amazon) return false;
      if (!term) return true;
      return [entry.merchant, entry.orderNumber, entry.evidence, entry.note, entry.cardId].join(" ").toLowerCase().includes(term);
    })
    .sort(transactionSorter(ui.sort));
}

function transactionSorter(sort) {
  if (sort === "oldest") {
    return (left, right) => String(left.transactionDate).localeCompare(String(right.transactionDate));
  }
  if (sort === "amount-high") {
    return (left, right) => Math.abs(Number(right.amount) || 0) - Math.abs(Number(left.amount) || 0);
  }
  if (sort === "amount-low") {
    return (left, right) => Math.abs(Number(left.amount) || 0) - Math.abs(Number(right.amount) || 0);
  }
  return (left, right) => String(right.transactionDate).localeCompare(String(left.transactionDate));
}

function summarizePurchaseTypes(transactions) {
  const summary = {
    all: { count: 0, chargeCount: 0, charges: 0 },
    amazon: { count: 0, chargeCount: 0, charges: 0 },
    other: { count: 0, chargeCount: 0, charges: 0 },
  };
  transactions.forEach((entry) => {
    const amount = Number(entry.amount) || 0;
    const type = entry.amazon ? "amazon" : "other";
    summary.all.count += 1;
    summary[type].count += 1;
    if (amount > 0) {
      summary.all.chargeCount += 1;
      summary[type].chargeCount += 1;
      summary.all.charges += amount;
      summary[type].charges += amount;
    }
  });
  return summary;
}

function summarizeActivity(transactions) {
  return transactions.reduce((summary, entry) => {
    const amount = Number(entry.amount) || 0;
    summary.count += 1;
    summary.net += amount;
    if (amount > 0) {
      summary.charges += amount;
      summary.chargeCount += 1;
    } else if (amount < 0) {
      summary.credits += Math.abs(amount);
      summary.creditCount += 1;
    }
    return summary;
  }, { count: 0, charges: 0, chargeCount: 0, credits: 0, creditCount: 0, net: 0 });
}

function purchaseClassification(entry) {
  if (entry.amazon) return Number(entry.amount) < 0 ? "Amazon business refund" : "Amazon business purchase";
  return Number(entry.amount) < 0 ? "Other credit" : "Other bill";
}

function summarize(transactions) {
  const result = {
    amazonHeld: 0, unmatchedAmount: 0, unmatchedCount: 0, refundsPending: 0, refundCount: 0,
    confirmedSpend: 0, confirmedCount: 0, needsReviewAmount: 0, needsReviewCount: 0,
    oldHoldAmount: 0, oldHoldCount: 0, reviewCount: 0,
  };
  const fifteenDaysAgo = new Date();
  fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
  const oldHoldBoundary = fifteenDaysAgo.toISOString().slice(0, 10);

  transactions.forEach((entry) => {
    const amount = Number(entry.amount) || 0;
    if (entry.amazon && entry.status === "held" && amount > 0) {
      result.amazonHeld += amount;
      if (entry.transactionDate && entry.transactionDate < oldHoldBoundary) {
        result.oldHoldCount += 1;
        result.oldHoldAmount += amount;
      }
    }
    if (entry.status === "unmatched" && amount > 0) {
      result.unmatchedCount += 1;
      result.unmatchedAmount += amount;
    }
    if (entry.status === "refund-pending" && amount < 0) {
      result.refundCount += 1;
      result.refundsPending += amount;
    }
    if (entry.status === "confirmed" && amount > 0) {
      result.confirmedCount += 1;
      result.confirmedSpend += amount;
    }
    if (entry.status === "review") {
      result.needsReviewCount += 1;
      result.needsReviewAmount += amount;
    }
  });
  result.reviewCount = result.unmatchedCount + result.refundCount + result.needsReviewCount + result.oldHoldCount;
  return result;
}

function buildExposure(cards, transactions) {
  return cards.map((card) => ({
    card,
    amount: transactions.reduce((sum, entry) => sum + (entry.cardId === card.id && entry.amazon && entry.status === "held" && Number(entry.amount) > 0 ? Number(entry.amount) : 0), 0),
  })).sort((left, right) => right.amount - left.amount);
}

function confidenceMarkup(value) {
  const number = Math.max(0, Math.min(100, Number(value) || 0));
  const tone = number >= 85 ? "high" : number >= 55 ? "medium" : "low";
  return `<span class="confidence ${tone}"><i style="width:${number}%"></i><b>${number}%</b></span>`;
}

function statusLabel(status) {
  return ({
    held: "Amazon hold", unmatched: "Unmatched", review: "Needs review",
    confirmed: "Confirmed", "refund-pending": "Refund pending", released: "Released",
  })[status] || "Unmatched";
}

function cardLabel(card) {
  return `${card.name} ${card.last4}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : shortDate.format(date);
}

function formatImportDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : shortDate.format(date);
}

function exportCsv(transactions, cards) {
  const byId = new Map(cards.map((card) => [card.id, cardLabel(card)]));
  const headers = ["Transaction Date", "Order Date", "Order Number", "Card", "Merchant", "Amount", "Amazon", "Confidence", "Status", "Evidence", "Notes"];
  const rows = transactions.map((entry) => [
    entry.transactionDate, entry.orderDate, entry.orderNumber, byId.get(entry.cardId) || entry.cardId,
    entry.merchant, entry.amount, entry.amazon ? "TRUE" : "FALSE", entry.confidence, statusLabel(entry.status), entry.evidence, entry.note,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `card-management-${isoToday()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

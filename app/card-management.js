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
  return {
    cards: Array.isArray(source.cards) && source.cards.length ? source.cards : DEFAULT_CARDS,
    transactions: Array.isArray(source.transactions) ? source.transactions : [],
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
    amazonOnly: false,
    endDate: isoToday(),
    editingId: "",
  };

  const render = () => {
    const visible = getVisibleTransactions(model.transactions, ui);
    const summary = summarize(visible);
    const exposure = buildExposure(model.cards, visible);
    const maxExposure = Math.max(1, ...exposure.map((entry) => entry.amount));

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
              <label class="amazon-filter">
                <input id="amazon-only" type="checkbox" ${ui.amazonOnly ? "checked" : ""} />
                Amazon only
              </label>
            </div>
            <div class="transaction-actions">
              <button id="export-card-csv" class="finance-button secondary" type="button">Export CSV</button>
              <button id="add-card-transaction" class="finance-button primary" type="button">Add transaction</button>
            </div>
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

    root.querySelector("#amazon-only")?.addEventListener("change", (event) => {
      ui.amazonOnly = event.target.checked;
      render();
    });
    root.querySelector("#add-card-transaction")?.addEventListener("click", () => {
      ui.editingId = "new";
      render();
    });
    root.querySelector("#export-card-csv")?.addEventListener("click", () => exportCsv(visible, model.cards));
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
          <td><strong>${escapeHtml(entry.merchant || "—")}</strong><small>${entry.amazon ? "Amazon" : "Other merchant"}</small></td>
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

function getVisibleTransactions(transactions, ui) {
  const from = ui.startDate || DEFAULT_START_DATE;
  const term = ui.search.trim().toLowerCase();
  return transactions
    .filter((entry) => {
      if (entry.transactionDate && entry.transactionDate < from) return false;
      if (entry.transactionDate && entry.transactionDate > ui.endDate) return false;
      if (ui.card !== "all" && entry.cardId !== ui.card) return false;
      if (ui.status !== "all" && entry.status !== ui.status) return false;
      if (ui.amazonOnly && !entry.amazon) return false;
      if (!term) return true;
      return [entry.merchant, entry.orderNumber, entry.evidence, entry.note, entry.cardId].join(" ").toLowerCase().includes(term);
    })
    .sort((left, right) => String(right.transactionDate).localeCompare(String(left.transactionDate)));
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

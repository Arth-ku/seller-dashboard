const config = window.__APP_CONFIG__ || {};
const basePath = config.basePath || "";

const elements = {
  summary: document.querySelector("#health-summary-text"),
  status: document.querySelector("#health-status"),
  lastRecorded: document.querySelector("#health-last-recorded"),
  bad: document.querySelector("#health-bad"),
  warn: document.querySelector("#health-warn"),
  snapshots: document.querySelector("#health-snapshots"),
  date: document.querySelector("#health-date"),
  problems: document.querySelector("#health-problems"),
  items: document.querySelector("#health-items"),
  refresh: document.querySelector("#refresh-health"),
};

function stateClass(state) {
  return `health-${["ok", "warn", "bad"].includes(state) ? state : "unknown"}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function formatDateTime(value) {
  if (!value) {
    return "No journal entry yet";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function itemTemplate(state, title, detail) {
  return `
    <article class="health-item">
      <span class="health-badge ${stateClass(state)}">${escapeHtml(state || "unknown")}</span>
      <div>
        <p class="health-item-title">${escapeHtml(title)}</p>
        <p class="health-item-detail">${escapeHtml(detail)}</p>
      </div>
    </article>
  `;
}

function problemTemplate(problem) {
  const detailParts = [
    problem.latestValue,
    problem.latestDetail,
    `${problem.badSnapshots || 0} bad / ${problem.warnSnapshots || 0} warn snapshots`,
  ].filter(Boolean);
  return `
    <article class="health-problem">
      <span class="health-badge ${stateClass(problem.latestState)}">${escapeHtml(problem.latestState || "warn")}</span>
      <div>
        <p class="health-problem-title">${escapeHtml(problem.label)}</p>
        <p class="health-problem-detail">${escapeHtml(detailParts.join(" - "))}</p>
      </div>
    </article>
  `;
}

function renderJournal(journal) {
  elements.status.textContent = journal.message || journal.status || "unknown";
  elements.status.className = "";
  elements.status.classList.add(stateClass(journal.status));
  elements.summary.textContent = journal.message === "all ok"
    ? "Everything checked today is clean."
    : "Some health checks need attention.";
  elements.lastRecorded.textContent = `Last recorded ${formatDateTime(journal.lastRecordedAt)}`;
  elements.bad.textContent = journal.latestCounts?.bad ?? 0;
  elements.warn.textContent = journal.latestCounts?.warn ?? 0;
  elements.snapshots.textContent = journal.snapshotCount ?? 0;
  elements.date.textContent = journal.date || "Today";

  const problems = journal.problems || [];
  elements.problems.innerHTML = problems.length
    ? problems.map(problemTemplate).join("")
    : '<div class="health-empty">No warnings or errors recorded today.</div>';
}

function renderHealthItems(payload) {
  const items = payload.items || [];
  elements.items.innerHTML = items.length
    ? items
        .map((item) => itemTemplate(item.state, item.label, [item.value, item.detail].filter(Boolean).join(" - ")))
        .join("")
    : '<div class="health-empty">No live health items returned.</div>';
}

async function loadHealth() {
  elements.refresh.disabled = true;
  elements.refresh.textContent = "Refreshing";
  try {
    const [journalResponse, healthResponse] = await Promise.all([
      fetch(`${basePath}/api/health/journal/today`, { cache: "no-store" }),
      fetch(`${basePath}/api/health`, { cache: "no-store" }),
    ]);
    if (!journalResponse.ok || !healthResponse.ok) {
      throw new Error("Health request failed");
    }
    renderJournal(await journalResponse.json());
    renderHealthItems(await healthResponse.json());
  } catch (error) {
    elements.summary.textContent = error.message || "Unable to load health status.";
    elements.status.textContent = "Error";
    elements.status.className = "health-bad";
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.textContent = "Refresh";
  }
}

elements.refresh.addEventListener("click", loadHealth);
loadHealth();

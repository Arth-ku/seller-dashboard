const CSV_HEADERS = [
  "Archive",
  "Items Name",
  "Price listed",
  "Revised",
  "Date:",
  "Self Expense",
  "Facebook",
  "Craiglist",
  "Ebay",
  "Mercari",
  "Budget",
  "Boost",
  "Boost 2",
  "Description of buyer",
  "Sold Day:",
  "Sold thruogh",
  "Final Price",
  "Notes",
];

export const COLUMN_DEFS = [
  { key: "boxId", label: "Box ID", type: "text", sticky: true },
  { key: "archived", label: "Archive", type: "checkbox" },
  { key: "itemName", label: "Item Name", type: "text", wide: true, sticky: true },
  { key: "priceListed", label: "Price Listed", type: "text" },
  { key: "revised", label: "Revised", type: "text" },
  { key: "priceChangedDate", label: "Date Changed", type: "text" },
  { key: "selfExpense", label: "Self Expense", type: "text" },
  { key: "facebook", label: "Facebook", type: "text" },
  { key: "craiglist", label: "Craiglist", type: "text" },
  { key: "ebay", label: "Ebay", type: "text" },
  { key: "mercari", label: "Mercari", type: "text" },
  { key: "budget", label: "Budget", type: "text" },
  { key: "boost", label: "Boost", type: "text" },
  { key: "boost2", label: "Boost 2", type: "text" },
  { key: "buyerDescription", label: "Description of Buyer", type: "text", wide: true },
  { key: "soldDay", label: "Sold Day", type: "text" },
  { key: "soldThrough", label: "Sold Through", type: "text" },
  { key: "finalPrice", label: "Final Price", type: "text" },
  { key: "notes", label: "Notes", type: "text", wide: true },
];

const FIELD_ORDER = [
  "archived",
  "itemName",
  "priceListed",
  "revised",
  "priceChangedDate",
  "selfExpense",
  "facebook",
  "craiglist",
  "ebay",
  "mercari",
  "budget",
  "boost",
  "boost2",
  "buyerDescription",
  "soldDay",
  "soldThrough",
  "finalPrice",
  "notes",
];

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        value += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }

      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      continue;
    }

    value += char;
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

export function rowsFromCsv(text) {
  const parsed = parseCsv(text)
    .map((row) => row.map((cell) => cell.trim()))
    .filter((row) => row.some((cell) => cell !== ""));

  if (!parsed.length) {
    return [];
  }

  const hasHeader = parsed[0].some((cell, index) => {
    const expected = CSV_HEADERS[index] || "";
    return cell.toLowerCase() === expected.toLowerCase();
  });

  const dataRows = hasHeader ? parsed.slice(1) : parsed;
  return normalizeImportedRows(dataRows);
}

export function createEmptyRow(existingRows = []) {
  const boxId = getNextUnknownBoxId(existingRows.map((row) => row.boxId));
  return {
    id: createRowId(),
    isDraft: true,
    boxId,
    archived: false,
    itemName: "",
    priceListed: "",
    revised: "",
    priceChangedDate: "",
    selfExpense: "",
    facebook: "",
    craiglist: "",
    ebay: "",
    mercari: "",
    budget: "",
    boost: "",
    boost2: "",
    buyerDescription: "",
    soldDay: "",
    soldThrough: "",
    finalPrice: "",
    notes: "",
  };
}

export function serializeRowsToCsv(rows) {
  const lines = [CSV_HEADERS];

  rows.forEach((row) => {
    if (shouldRemoveRow(row)) {
      return;
    }

    const values = FIELD_ORDER.map((key) => {
      if (key === "archived") {
        return row.archived ? "TRUE" : "FALSE";
      }
      return row[key] ?? "";
    });
    lines.push(values);
  });

  return lines.map((line) => line.map(escapeCsvValue).join(",")).join("\n");
}

export function extractLeadingBoxId(itemName) {
  const match = String(itemName || "").match(/^\s*(\d+)\b/);
  return match ? match[1] : "";
}

export function sanitizeBoxId(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toUpperCase();
}

export function ensureUniqueBoxId(candidate, rows, currentRowId) {
  const base = sanitizeBoxId(candidate) || getNextUnknownBoxId(rows.map((row) => row.boxId));
  const used = new Set(
    rows
      .filter((row) => row.id !== currentRowId)
      .map((row) => String(row.boxId || "").toUpperCase())
      .filter(Boolean),
  );

  if (!used.has(base)) {
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }

  return `${base}-${suffix}`;
}

export function pruneRows(rows) {
  return rows.filter((row) => !shouldRemoveRow(row));
}

export function normalizeRowState(row) {
  if (!row || typeof row !== "object") {
    return row;
  }

  const normalized = { ...row };
  if (hasMeaningfulContent(normalized)) {
    normalized.isDraft = false;
  } else if (normalized.isDraft == null) {
    normalized.isDraft = false;
  }

  return normalized;
}

function normalizeImportedRows(dataRows) {
  const rows = [];

  dataRows.forEach((cells) => {
    const row = createEmptyRow(rows);

    FIELD_ORDER.forEach((key, index) => {
      const raw = cells[index] ?? "";
      row[key] = key === "archived" ? /^true$/i.test(raw) : raw;
    });

    const derivedBoxId = extractLeadingBoxId(row.itemName);
    row.boxId = ensureUniqueBoxId(derivedBoxId || row.boxId, rows, row.id);
    row.isDraft = false;

    if (shouldRemoveRow(row)) {
      return;
    }

    rows.push(row);
  });

  return rows;
}

function createRowId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `row-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getNextUnknownBoxId(existingIds) {
  const used = new Set(existingIds.map((id) => String(id || "").toUpperCase()));
  let counter = 1;

  while (used.has(`UNKNOWN${counter}`)) {
    counter += 1;
  }

  return `UNKNOWN${counter}`;
}

function escapeCsvValue(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function shouldRemoveRow(row) {
  return !row?.isDraft && !hasMeaningfulContent(row);
}

function hasMeaningfulContent(row) {
  return FIELD_ORDER.some((key) => {
    if (key === "archived") {
      return row.archived === true;
    }

    return String(row[key] ?? "").trim() !== "";
  });
}

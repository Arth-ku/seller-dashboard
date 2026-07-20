const defaultState = {
  rows: [],
  productDetails: {},
  meta: {},
  cardManagement: {},
};

let cachedState = { ...defaultState };
let persistQueue = Promise.resolve();
const APP_CONFIG = window.__APP_CONFIG__ || {};
const BASE_PATH = normalizeBasePath(APP_CONFIG.basePath);

export async function fetchSession() {
  try {
    const response = await fetch(toApiUrl("/api/session"), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return { authenticated: false, authRequired: true };
    }
    const payload = await response.json();
    return {
      authenticated: Boolean(payload.authenticated),
      authRequired: Boolean(payload.authRequired),
    };
  } catch (error) {
    return { authenticated: false, authRequired: true };
  }
}

export async function login(password) {
  const response = await fetch(toApiUrl("/api/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (response.status === 401) {
    return { ok: false, error: "Incorrect password." };
  }

  if (!response.ok) {
    return { ok: false, error: "Login failed. Please try again." };
  }

  return { ok: true };
}

export async function logout() {
  await fetch(toApiUrl("/api/logout"), { method: "POST" });
}

export async function loadAppState() {
  const response = await fetch(toApiUrl("/api/state"), {
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    const error = new Error("Not authenticated.");
    error.unauthorized = true;
    throw error;
  }

  if (!response.ok) {
    throw new Error("Failed to load shared app state from the server.");
  }

  const payload = await response.json();
  cachedState = {
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    productDetails:
      payload.productDetails && typeof payload.productDetails === "object" ? payload.productDetails : {},
    meta: payload.meta && typeof payload.meta === "object" ? payload.meta : {},
    cardManagement:
      payload.cardManagement && typeof payload.cardManagement === "object" ? payload.cardManagement : {},
  };

  return { ...cachedState };
}

export async function loadHistorySnapshots() {
  const response = await fetch(toApiUrl("/api/history"), {
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    const error = new Error("Not authenticated.");
    error.unauthorized = true;
    throw error;
  }

  if (!response.ok) {
    throw new Error("Failed to load dashboard history.");
  }

  const payload = await response.json();
  return Array.isArray(payload.snapshots) ? payload.snapshots : [];
}

export async function loadHistoryState(snapshotId) {
  const response = await fetch(toApiUrl(`/api/history/state?id=${encodeURIComponent(snapshotId)}`), {
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    const error = new Error("Not authenticated.");
    error.unauthorized = true;
    throw error;
  }

  if (!response.ok) {
    throw new Error("Failed to load selected dashboard history.");
  }

  return response.json();
}

export async function loadHealth() {
  const response = await fetch(toApiUrl("/api/health"), {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to load site health from the server.");
  }

  return response.json();
}

export async function loadLucyInsights() {
  const response = await fetch(toApiUrl("/api/lucy/insights"), {
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    const error = new Error("Not authenticated.");
    error.unauthorized = true;
    throw error;
  }

  if (!response.ok) {
    throw new Error("Failed to load Lucy insights from the server.");
  }

  return response.json();
}

export async function runLucyAnalysis() {
  const response = await fetch(toApiUrl("/api/lucy/analyze"), {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    const error = new Error("Not authenticated.");
    error.unauthorized = true;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || "Failed to run Lucy analysis.");
  }

  return payload.insights || payload;
}

export async function refreshGoogleSheet() {
  const response = await fetch(toApiUrl("/api/import/google-sheet"), {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    const error = new Error("Not authenticated.");
    error.unauthorized = true;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || "Failed to refresh the Google Sheet.");
  }

  return payload;
}

export async function loadOrderProcessState() {
  const response = await fetch(toApiUrl("/api/order-process"), {
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    const error = new Error("Not authenticated.");
    error.unauthorized = true;
    throw error;
  }

  if (!response.ok) {
    throw new Error("Failed to load the order process from the server.");
  }

  return response.json();
}

export async function loadOrderProcessHistory() {
  const response = await fetch(toApiUrl("/api/order-process/history"), {
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    const error = new Error("Not authenticated.");
    error.unauthorized = true;
    throw error;
  }

  if (!response.ok) {
    throw new Error("Failed to load order process history.");
  }

  const payload = await response.json();
  return Array.isArray(payload.snapshots) ? payload.snapshots : [];
}

export async function loadOrderProcessHistoryState(snapshotId) {
  const response = await fetch(
    toApiUrl(`/api/order-process/history/state?id=${encodeURIComponent(snapshotId)}`),
    {
      headers: {
        Accept: "application/json",
      },
    },
  );

  if (response.status === 401) {
    const error = new Error("Not authenticated.");
    error.unauthorized = true;
    throw error;
  }

  if (!response.ok) {
    throw new Error("Failed to load the selected order process history.");
  }

  return response.json();
}

export async function refreshOrderProcessSheet() {
  const response = await fetch(toApiUrl("/api/order-process/import"), {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    const error = new Error("Not authenticated.");
    error.unauthorized = true;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload.error || payload.message || "Failed to refresh the order process Google Sheet.",
    );
  }

  return payload;
}

export async function saveRows(rows, options = {}) {
  await saveAppState({ rows }, options);
}

export async function saveProductDetails(productDetails, options = {}) {
  await saveAppState({ productDetails }, options);
}

export async function saveMeta(meta, options = {}) {
  await saveAppState({ meta }, options);
}

export async function saveAppState(partialState, options = {}) {
  cachedState = { ...cachedState, ...partialState };
  await persistState(options);
}

export async function uploadImages(boxId, files) {
  const formData = new FormData();
  files.forEach((file) => formData.append("images", file));

  const response = await fetch(toApiUrl(`/api/upload?boxId=${encodeURIComponent(boxId)}`), {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error("Failed to upload images to the server.");
  }

  const payload = await response.json();
  return Array.isArray(payload.images) ? payload.images : [];
}

async function persistState(options = {}) {
  const snapshot = JSON.stringify({
    ...cachedState,
    saveReason: options.reason || "save",
  });
  persistQueue = persistQueue.then(() => persistSnapshot(snapshot), () => persistSnapshot(snapshot));
  return persistQueue;
}

async function persistSnapshot(snapshot) {
  const response = await fetch(toApiUrl("/api/state"), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: snapshot,
  });

  if (!response.ok) {
    throw new Error("Failed to save shared app state to the server.");
  }
}

function normalizeBasePath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function toApiUrl(path) {
  return `${BASE_PATH}${path}`;
}

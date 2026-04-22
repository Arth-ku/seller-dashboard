const defaultState = {
  rows: [],
  productDetails: {},
  meta: {},
};

let cachedState = { ...defaultState };
let persistQueue = Promise.resolve();
const APP_CONFIG = window.__APP_CONFIG__ || {};
const BASE_PATH = normalizeBasePath(APP_CONFIG.basePath);

export async function loadAppState() {
  const response = await fetch(toApiUrl("/api/state"), {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to load shared app state from the server.");
  }

  const payload = await response.json();
  cachedState = {
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    productDetails:
      payload.productDetails && typeof payload.productDetails === "object" ? payload.productDetails : {},
    meta: payload.meta && typeof payload.meta === "object" ? payload.meta : {},
  };

  return { ...cachedState };
}

export async function saveRows(rows) {
  await saveAppState({ rows });
}

export async function saveProductDetails(productDetails) {
  await saveAppState({ productDetails });
}

export async function saveMeta(meta) {
  await saveAppState({ meta });
}

export async function saveAppState(partialState) {
  cachedState = { ...cachedState, ...partialState };
  await persistState();
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

async function persistState() {
  const snapshot = JSON.stringify(cachedState);
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

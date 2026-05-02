const app = document.querySelector("#app");
const CONFIG = window.AUTH_APP_CONFIG || {};
const API_BASE = normalizeBase(CONFIG.apiBase || "/sell");
let qrStream = null;
let qrScanFrame = null;

if (API_BASE == null) {
  renderError("Set `window.AUTH_APP_CONFIG.apiBase` in `cloudflare-auth/index.html` first.");
} else {
  init().catch((error) => {
    console.error(error);
    renderError("The authenticity page could not load.");
  });
}

async function init() {
  if (isRootPath()) {
    renderHomePage();
    return;
  }

  const catalog = getCatalogFromPath();
  if (catalog) {
    await renderCatalogPage(catalog);
    return;
  }

  const boxId = getBoxIdFromPath();
  if (!boxId) {
    renderError("No box ID found in this URL.");
    return;
  }

  app.innerHTML = `
    <main class="public-shell">
      <section class="public-card loading-card">
        <p class="eyebrow">Authenticity</p>
        <h1>${escapeHtml(boxId)}</h1>
        <p class="muted">Loading product details...</p>
      </section>
    </main>
  `;

  const response = await fetch(`${API_BASE}/api/public/products/${encodeURIComponent(boxId)}`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 404) {
    renderError(`No public authenticity data found for box ID ${boxId}.`);
    return;
  }

  if (!response.ok) {
    throw new Error(`Public API request failed with status ${response.status}`);
  }

  const product = await response.json();
  renderProduct(product);
}

function renderProduct(product) {
  const sourceCatalog = getSourceCatalog();
  app.innerHTML = `
    <main class="public-shell">
      ${
        sourceCatalog
          ? `<nav class="public-nav"><a class="back-link" href="/${sourceCatalog.path}">Back to ${escapeHtml(sourceCatalog.label)}</a></nav>`
          : ""
      }
      <section class="public-card hero-card">
        <p class="eyebrow">Authenticity</p>
        <h1>${escapeHtml(product.boxId || "Unknown")}</h1>
        <p class="subtitle">${escapeHtml(product.itemName || "No item name available.")}</p>
        <div class="pill-row">
          <span class="pill">${escapeHtml(product.price || "No price added")}</span>
        </div>
      </section>

      <section class="public-card">
        <div class="section-head">
          <h2>Photos</h2>
        </div>
        <div class="image-grid">
          ${
            Array.isArray(product.images) && product.images.length
              ? product.images
                  .map(
                    (image, index) => `
                      <figure class="image-card">
                        <a
                          class="image-link"
                          href="${escapeAttribute(image.url || "")}"
                          target="_blank"
                          rel="noopener noreferrer"
                          data-preview-index="${index}"
                          data-preview-image="${escapeAttribute(image.url || "")}"
                          data-preview-name="${escapeAttribute(image.name || `Image ${index + 1}`)}"
                        >
                          <img src="${escapeAttribute(image.url || "")}" alt="${escapeAttribute(image.name || `Image ${index + 1}`)}" draggable="false" />
                        </a>
                      </figure>
                    `,
                  )
                  .join("")
              : `<p class="muted">No photos uploaded yet.</p>`
          }
        </div>
      </section>

      <section class="content-grid">
        <article class="public-card">
          <div class="section-head">
            <h2>Title</h2>
          </div>
          <p class="content-text">${escapeHtml(product.title || "No title added yet.")}</p>
        </article>
        <article class="public-card">
          <div class="section-head">
            <h2>Description</h2>
          </div>
          <p class="content-text description-text">${escapeHtml(product.description || "No description added yet.")}</p>
        </article>
        <article class="public-card">
          <div class="section-head">
            <h2>Price</h2>
          </div>
          <p class="price-text">${escapeHtml(product.price || "No price added")}</p>
        </article>
      </section>
    </main>
  `;

  bindImagePreviewEvents();
}

function renderHomePage() {
  app.innerHTML = `
    <main class="startup-page">
      <video id="startup-video" class="startup-video" src="/assets/startup.mp4" autoplay loop playsinline></video>
      <div class="startup-shade"></div>
      <section class="startup-panel">
        <h1>Authenticity Check</h1>
        <div class="startup-control-row">
          <form id="home-search-form" class="startup-search">
            <input id="home-search-input" type="search" inputmode="search" autocomplete="off" placeholder="Box ID" aria-label="Search box ID" />
            <button class="startup-action-button" type="submit">Search</button>
            <button id="qr-scan-button" class="startup-qr-button" type="button" aria-label="Scan QR code">QR</button>
          </form>
          <button id="sound-toggle" class="sound-toggle is-on" type="button">Sound On</button>
        </div>
      </section>
    </main>
  `;

  bindHomeEvents();
}

function bindHomeEvents() {
  const form = document.querySelector("#home-search-form");
  const input = document.querySelector("#home-search-input");
  const qrButton = document.querySelector("#qr-scan-button");
  const soundButton = document.querySelector("#sound-toggle");
  const startupVideo = document.querySelector("#startup-video");

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    navigateFromCode(input?.value || "");
  });

  qrButton?.addEventListener("click", () => {
    openQrScanner();
  });

  soundButton?.addEventListener("click", async () => {
    if (!startupVideo) {
      return;
    }

    startupVideo.muted = !startupVideo.muted;
    soundButton.classList.toggle("is-on", !startupVideo.muted);
    soundButton.textContent = startupVideo.muted ? "Sound" : "Sound On";
    await startupVideo.play().catch(() => {});
  });

  if (startupVideo) {
    startupVideo.muted = false;
    startupVideo
      .play()
      .then(() => {
        soundButton?.classList.add("is-on");
        if (soundButton) {
          soundButton.textContent = "Sound On";
        }
      })
      .catch(async () => {
        startupVideo.muted = true;
        soundButton?.classList.remove("is-on");
        if (soundButton) {
          soundButton.textContent = "Sound";
        }
        await startupVideo.play().catch(() => {});
      });
  }
}

function navigateFromCode(value) {
  const destination = getDestinationFromCode(value);
  if (!destination) {
    return;
  }

  window.location.href = destination;
}

function getDestinationFromCode(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    return `${url.pathname || "/"}${url.search || ""}`;
  } catch {
    const cleaned = raw.replace(/^\/+/, "").split(/\s+/)[0];
    if (!cleaned) {
      return "";
    }

    return `/${encodeURIComponent(cleaned)}`;
  }
}

async function openQrScanner() {
  closeQrScanner();
  const overlay = document.createElement("div");
  overlay.className = "qr-modal";
  overlay.innerHTML = `
    <div class="qr-backdrop" data-close-qr></div>
    <section class="qr-dialog" role="dialog" aria-modal="true" aria-label="QR scanner">
      <button class="qr-close" type="button" data-close-qr aria-label="Close QR scanner">Close</button>
      <video id="qr-camera" class="qr-camera" autoplay muted playsinline></video>
      <p id="qr-status" class="qr-status">Opening camera...</p>
    </section>
  `;

  document.body.append(overlay);
  overlay.querySelectorAll("[data-close-qr]").forEach((element) => {
    element.addEventListener("click", closeQrScanner);
  });

  const status = overlay.querySelector("#qr-status");
  const video = overlay.querySelector("#qr-camera");

  try {
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
      },
      audio: false,
    });
    video.srcObject = qrStream;
    await video.play();
  } catch {
    status.textContent = "Camera is unavailable.";
    return;
  }

  if (!("BarcodeDetector" in window)) {
    status.textContent = "QR scanning is unavailable in this browser.";
    return;
  }

  let detector;
  try {
    detector = new BarcodeDetector({ formats: ["qr_code"] });
  } catch {
    status.textContent = "QR decoding is unavailable in this browser.";
    return;
  }

  status.textContent = "Point camera at QR code.";

  const scan = async () => {
    try {
      const codes = await detector.detect(video);
      const rawValue = codes[0]?.rawValue;
      if (rawValue) {
        const destination = getDestinationFromQrCode(rawValue);
        if (destination) {
          closeQrScanner();
          window.location.href = destination;
          return;
        }

        status.textContent = "QR code is not a valid product URL.";
        return;
      }
    } catch {
      status.textContent = "Still looking for QR code...";
    }

    qrScanFrame = window.requestAnimationFrame(scan);
  };

  scan();
}

function getDestinationFromQrCode(value) {
  try {
    return new URL(String(value || "").trim()).href;
  } catch {
    return "";
  }
}

function closeQrScanner() {
  if (qrScanFrame) {
    window.cancelAnimationFrame(qrScanFrame);
    qrScanFrame = null;
  }

  if (qrStream) {
    qrStream.getTracks().forEach((track) => track.stop());
    qrStream = null;
  }

  document.querySelector(".qr-modal")?.remove();
}

async function renderCatalogPage(catalog) {
  app.innerHTML = `
    <main class="public-shell">
      <section class="public-card loading-card">
        <p class="eyebrow">${escapeHtml(catalog.label)}</p>
        <h1>${escapeHtml(catalog.label)}</h1>
        <p class="muted">Loading available boxes...</p>
      </section>
    </main>
  `;

  const response = await fetch(`${API_BASE}/api/public/${catalog.path}`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Public ${catalog.path} request failed with status ${response.status}`);
  }

  const payload = await response.json();
  renderCatalogList(catalog, Array.isArray(payload.products) ? payload.products : [], Array.isArray(payload.clients) ? payload.clients : []);
}

function renderCatalogList(catalog, products, clients) {
  app.innerHTML = `
    <main class="public-shell apparel-shell">
      <section class="apparel-header">
        <div class="apparel-controls">
          <label class="control-field">
            <span>Search</span>
            <input id="apparel-search" type="search" placeholder="Search box, title, price..." />
          </label>
          <div class="client-filter" role="group" aria-label="${escapeAttribute(catalog.label)} client filter">
            <button class="client-filter-button is-active" type="button" data-client-filter="">All</button>
            ${clients
              .map(
                (client) => `
                  <button class="client-filter-button" type="button" data-client-filter="${escapeAttribute(client)}">${escapeHtml(client)}</button>
                `,
              )
              .join("")}
          </div>
        </div>
      </section>
      <section id="apparel-results" class="apparel-grid"></section>
    </main>
  `;

  const searchInput = document.querySelector("#apparel-search");
  const clientButtons = Array.from(document.querySelectorAll("[data-client-filter]"));
  let selectedClient = "";
  const renderResults = () => {
    const term = String(searchInput?.value || "").trim().toLowerCase();
    const filtered = products.filter((product) => {
      if (selectedClient && product.client !== selectedClient) {
        return false;
      }

      if (!term) {
        return true;
      }

      return [product.boxId, product.title, product.itemName, product.price, product.client]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });

    renderCatalogResults(catalog, filtered);
  };

  searchInput?.addEventListener("input", renderResults);
  clientButtons.forEach((button) => {
    button.addEventListener("click", () => {
      selectedClient = button.dataset.clientFilter || "";
      clientButtons.forEach((item) => item.classList.toggle("is-active", item === button));
      renderResults();
    });
  });
  renderResults();
}

function renderCatalogResults(catalog, products) {
  const results = document.querySelector("#apparel-results");
  if (!results) {
    return;
  }

  if (!products.length) {
    results.innerHTML = `<p class="muted empty-results">No ${escapeHtml(catalog.label.toLowerCase())} boxes match this search.</p>`;
    return;
  }

  results.innerHTML = products.map((product) => renderCatalogCard(product, catalog)).join("");
}

function renderCatalogCard(product, catalog) {
  const href = `/${encodeURIComponent(product.boxId || "")}?from=${encodeURIComponent(catalog.path)}`;
  const title = product.title || product.itemName || "";
  const images = Array.isArray(product.images) ? product.images.slice(0, 1) : [];
  return `
    <a class="apparel-card" href="${escapeAttribute(href)}">
      <div class="apparel-preview">
        ${
          images.length
            ? images
                .map(
                  (image, index) => `
                    <img src="${escapeAttribute(image.url || "")}" alt="${escapeAttribute(image.name || `Preview ${index + 1}`)}" loading="lazy" decoding="async" fetchpriority="low" />
                  `,
                )
                .join("")
            : `<div class="apparel-no-photo">No photo</div>`
        }
      </div>
      <div class="apparel-card-body">
        <div class="apparel-card-topline">
          <span class="box-pill">${escapeHtml(product.boxId || "Unknown")}</span>
          <span class="price-pill">${escapeHtml(product.price || "No price")}</span>
        </div>
        ${title ? `<h2>${escapeHtml(title)}</h2>` : ""}
        ${product.client ? `<p class="client-label">${escapeHtml(product.client)}</p>` : ""}
      </div>
    </a>
  `;
}

function getBoxIdFromPath() {
  const parts = decodeURIComponent(window.location.pathname).split("/").filter(Boolean);
  if (!parts.length) {
    return "";
  }

  if (parts[0].toLowerCase() === "authenticity") {
    return parts[1] || "";
  }

  if (parts.length >= 2 && parts[1].toLowerCase() === "authenticity") {
    return parts[0];
  }

  return parts[0];
}

function isRootPath() {
  return decodeURIComponent(window.location.pathname).split("/").filter(Boolean).length === 0;
}

function getCatalogFromPath() {
  const parts = decodeURIComponent(window.location.pathname).split("/").filter(Boolean);
  if (parts.length !== 1) {
    return null;
  }

  return getCatalogConfig(parts[0]);
}

function getSourceCatalog() {
  return getCatalogConfig(new URLSearchParams(window.location.search).get("from"));
}

function getCatalogConfig(value) {
  const key = String(value || "").toLowerCase();
  const catalogs = {
    apparel: {
      path: "apparel",
      label: "Apparel",
    },
    hvac: {
      path: "hvac",
      label: "HVAC",
    },
  };

  return catalogs[key] || null;
}

function normalizeBase(value) {
  const trimmed = String(value || "").trim();
  return trimmed.replace(/\/+$/, "");
}

function renderError(message) {
  app.innerHTML = `
    <main class="public-shell">
      <section class="public-card error-card">
        <p class="eyebrow">Authenticity</p>
        <h1>Unavailable</h1>
        <p class="muted">${escapeHtml(message)}</p>
      </section>
    </main>
  `;
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

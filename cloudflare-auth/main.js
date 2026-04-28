const app = document.querySelector("#app");
const CONFIG = window.AUTH_APP_CONFIG || {};
const API_BASE = normalizeBase(CONFIG.apiBase || "/sell");

if (API_BASE == null) {
  renderError("Set `window.AUTH_APP_CONFIG.apiBase` in `cloudflare-auth/index.html` first.");
} else {
  init().catch((error) => {
    console.error(error);
    renderError("The authenticity page could not load.");
  });
}

async function init() {
  if (isApparelPath()) {
    await renderApparelPage();
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
  app.innerHTML = `
    <main class="public-shell">
      <nav class="public-nav">
        <a class="back-link" href="/apparel">Back to Apparel</a>
      </nav>
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

async function renderApparelPage() {
  app.innerHTML = `
    <main class="public-shell">
      <section class="public-card loading-card">
        <p class="eyebrow">Apparel</p>
        <h1>Apparel</h1>
        <p class="muted">Loading available boxes...</p>
      </section>
    </main>
  `;

  const response = await fetch(`${API_BASE}/api/public/apparel`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Public apparel request failed with status ${response.status}`);
  }

  const payload = await response.json();
  renderApparelList(Array.isArray(payload.products) ? payload.products : [], Array.isArray(payload.clients) ? payload.clients : []);
}

function renderApparelList(products, clients) {
  app.innerHTML = `
    <main class="public-shell apparel-shell">
      <section class="apparel-header">
        <div>
          <p class="eyebrow">Apparel</p>
          <h1>Apparel</h1>
          <p class="subtitle">${escapeHtml(products.length ? `${products.length} boxes from 1000 to 1100` : "No boxes found from 1000 to 1100.")}</p>
        </div>
        <div class="apparel-controls">
          <label class="control-field">
            <span>Search</span>
            <input id="apparel-search" type="search" placeholder="Search box, title, price..." />
          </label>
          <label class="control-field">
            <span>Client</span>
            <select id="apparel-client">
              <option value="">All clients</option>
              ${clients.map((client) => `<option value="${escapeAttribute(client)}">${escapeHtml(client)}</option>`).join("")}
            </select>
          </label>
        </div>
      </section>
      <section id="apparel-results" class="apparel-grid"></section>
    </main>
  `;

  const searchInput = document.querySelector("#apparel-search");
  const clientSelect = document.querySelector("#apparel-client");
  const renderResults = () => {
    const term = String(searchInput?.value || "").trim().toLowerCase();
    const client = String(clientSelect?.value || "");
    const filtered = products.filter((product) => {
      if (client && product.client !== client) {
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

    renderApparelResults(filtered);
  };

  searchInput?.addEventListener("input", renderResults);
  clientSelect?.addEventListener("change", renderResults);
  renderResults();
}

function renderApparelResults(products) {
  const results = document.querySelector("#apparel-results");
  if (!results) {
    return;
  }

  if (!products.length) {
    results.innerHTML = `<p class="muted empty-results">No apparel boxes match this search.</p>`;
    return;
  }

  results.innerHTML = products.map(renderApparelCard).join("");
}

function renderApparelCard(product) {
  const href = `/${encodeURIComponent(product.boxId || "")}`;
  const title = product.title || product.itemName || "No title added yet.";
  const images = Array.isArray(product.images) ? product.images.slice(0, 4) : [];
  return `
    <a class="apparel-card" href="${escapeAttribute(href)}">
      <div class="apparel-preview ${images.length > 1 ? "has-multiple" : ""}">
        ${
          images.length
            ? images
                .map(
                  (image, index) => `
                    <img src="${escapeAttribute(image.url || "")}" alt="${escapeAttribute(image.name || `Preview ${index + 1}`)}" loading="lazy" />
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
        <h2>${escapeHtml(title)}</h2>
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

function isApparelPath() {
  const parts = decodeURIComponent(window.location.pathname).split("/").filter(Boolean);
  return parts.length === 1 && parts[0].toLowerCase() === "apparel";
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

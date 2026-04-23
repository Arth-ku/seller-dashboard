const app = document.querySelector("#app");
const CONFIG = window.AUTH_APP_CONFIG || {};
const API_BASE = normalizeBase(CONFIG.apiBase);

if (!API_BASE) {
  renderError("Set `window.AUTH_APP_CONFIG.apiBase` in `cloudflare-auth/index.html` first.");
} else {
  init().catch((error) => {
    console.error(error);
    renderError("The authenticity page could not load.");
  });
}

async function init() {
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
  document.querySelectorAll("[data-preview-image]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      openImageLightbox(button.dataset.previewImage, button.dataset.previewName);
    });
  });
}

function openImageLightbox(src, name = "Preview") {
  if (!src) {
    return;
  }

  closeImageLightbox();
  const overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  overlay.innerHTML = `
    <div class="image-lightbox-backdrop" data-close-lightbox></div>
    <div class="image-lightbox-dialog" role="dialog" aria-modal="true" aria-label="${escapeAttribute(name)}">
      <button class="image-lightbox-close" type="button" data-close-lightbox aria-label="Close image preview">Close</button>
      <img src="${escapeAttribute(src)}" alt="${escapeAttribute(name)}" />
    </div>
  `;

  overlay.querySelectorAll("[data-close-lightbox]").forEach((element) => {
    element.addEventListener("click", closeImageLightbox);
  });

  document.body.append(overlay);
}

function closeImageLightbox() {
  document.querySelector(".image-lightbox")?.remove();
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

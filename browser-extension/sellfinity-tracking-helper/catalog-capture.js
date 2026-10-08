function catalogCaptureError(message, code) {
  return Object.assign(new Error(message), { code });
}

function checkCatalogVerification(doc) {
  const pageText = (doc.body?.innerText || "").slice(0, 15000);
  if (globalThis.sellfinityAmazonAvailabilityFromPage?.(doc) === "BLOCKED" || /enter the characters you see below|not a robot|robot check/i.test(`${doc.title} ${pageText}`)) throw catalogCaptureError("Amazon requires verification. Complete it manually before retrying.", "VERIFICATION_REQUIRED");
}

globalThis.sellfinityCaptureCatalogProduct = function captureCatalogProduct(doc = document, url = location.href) {
  checkCatalogVerification(doc);
  if (doc.readyState && doc.readyState !== "complete") throw catalogCaptureError("Amazon product details are still loading.", "PAGE_LOADING");
  const asin = doc.querySelector('input#ASIN')?.value || url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
  const title = doc.querySelector("#productTitle")?.textContent?.trim();
  if (!asin || !title) throw catalogCaptureError("Amazon product details are not readable yet. Check that this is a product page.", "PRODUCT_NOT_READABLE");
  const cost = globalThis.sellfinityAmazonPriceFromPage(doc);
  const available = globalThis.sellfinityAmazonAvailabilityFromPage(doc);
  const breadcrumbs = [...doc.querySelectorAll("#wayfinding-breadcrumbs_feature_div a")].map((el) => el.textContent.trim()).filter(Boolean);
  const bulletPoints = [...doc.querySelectorAll("#feature-bullets li .a-list-item")].map((el) => el.textContent.trim()).filter((text) => text && !/make sure this fits/i.test(text)).slice(0, 15);
  const main = doc.querySelector("#landingImage, #imgBlkFront");
  const normalizeImage = (value) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || !/(^|\.)(media-amazon\.com|images-amazon\.com|ssl-images-amazon\.com)$/.test(parsed.hostname)) return null;
      if (!/\.(?:jpg|jpeg|png|webp)$/i.test(parsed.pathname) || /(?:sprite|play-button|transparent|video)/i.test(parsed.pathname)) return null;
      // Remove Amazon's thumbnail/resize transform, retaining the original photo ID.
      parsed.pathname = parsed.pathname.replace(/\._[^/]+_\.(jpg|jpeg|png|webp)$/i, ".$1");
      return parsed.href;
    } catch { return null; }
  };
  const gallery = [main, ...doc.querySelectorAll("#altImages img")].filter(Boolean);
  const imageCandidates = gallery.flatMap((el) => {
    let dynamic = [];
    try { dynamic = Object.entries(JSON.parse(el.getAttribute("data-a-dynamic-image") || "{}")).sort((a, b) => (Number(b[1]?.[0]) * Number(b[1]?.[1]) || 0) - (Number(a[1]?.[0]) * Number(a[1]?.[1]) || 0)).map(([image]) => image); } catch { /* Other gallery attributes remain usable. */ }
    return [el.getAttribute("data-old-hires"), ...dynamic, el.getAttribute("src"), el.getAttribute("data-src")];
  });
  const images = [...new Set(imageCandidates.map(normalizeImage).filter(Boolean))].slice(0, 12);
  const descriptionSections = [...doc.querySelectorAll("#productDescription, #aplus, #aplus_feature_div")].map((section) => {
    const copy = section.cloneNode?.(true) || section;
    if (copy !== section) for (const noise of copy.querySelectorAll("script, style, noscript, .aplus-comparison-table, .aplus-module-comparison, [aria-hidden='true']")) noise.remove();
    return (copy.innerText || copy.textContent || "").replace(/\s+/g, " ").trim();
  }).filter(Boolean);
  const description = [...new Set(descriptionSections)].filter((text, index, values) => !values.some((other, otherIndex) => otherIndex !== index && other.length > text.length && other.includes(text))).join("\n\n").slice(0, 10000);
  const variant = [...doc.querySelectorAll('#twister .selection, #twister .a-button-selected .a-button-text, #variation_size_name .selection, #variation_color_name .selection')].map((el) => el.textContent.trim()).filter(Boolean).join(" · ");
  return {
    asin: asin.toUpperCase(), title, brand: (doc.querySelector("#bylineInfo")?.textContent || "").trim().replace(/^Visit the (.+) Store$/i, "$1").replace(/^Brand:\s*/i, ""),
    category: breadcrumbs.join(" > ").slice(0, 200) || "Other", variant: variant.slice(0, 500),
    priceCents: cost?.unitPriceCents ?? 0, shippingCents: cost?.shippingCents ?? null,
    availability: available === "UNAVAILABLE" ? "UNAVAILABLE" : cost ? "AVAILABLE" : "UNKNOWN",
    images, bulletPoints, description,
    source: "BROWSER", sourceUrl: `https://www.amazon.com/dp/${asin.toUpperCase()}`,
  };
};

globalThis.sellfinityCaptureBestsellers = function captureBestsellers(doc = document, url = location.href) {
  checkCatalogVerification(doc);
  if (!/\/zgbs(?:\/|$)|\/Best-Sellers/i.test(new URL(url).pathname)) throw new Error("Open an Amazon Best Sellers category page.");
  if (doc.readyState && doc.readyState !== "complete") throw catalogCaptureError("Amazon bestseller details are still loading.", "PAGE_LOADING");
  const category = doc.querySelector("#zg_banner_text, #zg_browseRoot .zg_selected, h1")?.textContent?.trim() || doc.title;
  const cards = [...doc.querySelectorAll(".zg-grid-general-faceout, .p13n-sc-uncoverable-faceout")];
  const candidates = cards.flatMap((card) => {
    const anchor = [...card.querySelectorAll("a[href]")].find((link) => /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(link.href));
    const asin = anchor?.href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase();
    const rank = Number(card.querySelector(".zg-bdg-text")?.textContent?.replace(/[^0-9]/g, ""));
    if (!asin || !rank) return [];
    return [{ asin, amazonUrl: `https://www.amazon.com/dp/${asin}`, bestsellerRank: rank, bestsellerCategory: category.slice(0, 200), bestsellerUrl: url }];
  });
  if (!candidates.length) throw catalogCaptureError("No ranked bestseller cards were readable on this page.", "BESTSELLERS_NOT_READABLE");
  return [...new Map(candidates.map((row) => [row.asin, row])).values()];
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!["CAPTURE_CATALOG_PRODUCT", "CAPTURE_BESTSELLER_PAGE"].includes(message?.type)) return;
  try {
    sendResponse({ ok: true, result: message.type === "CAPTURE_CATALOG_PRODUCT" ? globalThis.sellfinityCaptureCatalogProduct() : globalThis.sellfinityCaptureBestsellers() });
  } catch (error) { sendResponse({ ok: false, error: error.message, code: error.code || "CAPTURE_FAILED", blocked: error.code === "VERIFICATION_REQUIRED" }); }
  return true;
});

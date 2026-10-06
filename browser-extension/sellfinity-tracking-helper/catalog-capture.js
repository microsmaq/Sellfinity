globalThis.sellfinityCaptureCatalogProduct = function captureCatalogProduct(doc = document, url = location.href) {
  const pageText = (doc.body?.innerText || "").slice(0, 15000);
  if (/enter the characters you see below|not a robot|robot check/i.test(`${doc.title} ${pageText}`)) throw new Error("Amazon requires CAPTCHA verification. Complete it manually before retrying.");
  const asin = doc.querySelector('input#ASIN')?.value || url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
  const title = doc.querySelector("#productTitle")?.textContent?.trim();
  if (!asin || !title) throw new Error("Open a complete Amazon product page first. Sign in if required.");
  const cost = globalThis.sellfinityAmazonPriceFromPage(doc);
  const available = globalThis.sellfinityAmazonAvailabilityFromPage(doc);
  const breadcrumbs = [...doc.querySelectorAll("#wayfinding-breadcrumbs_feature_div a")].map((el) => el.textContent.trim()).filter(Boolean);
  const bulletPoints = [...doc.querySelectorAll("#feature-bullets li .a-list-item")].map((el) => el.textContent.trim()).filter((text) => text && !/make sure this fits/i.test(text)).slice(0, 15);
  const main = doc.querySelector("#landingImage, #imgBlkFront");
  const images = [...new Set([main?.getAttribute("data-old-hires"), main?.getAttribute("src"), ...[...doc.querySelectorAll("#altImages img")].map((el) => el.getAttribute("src"))].filter((value) => value && /^https:\/\//.test(value) && /(^|\.)(media-amazon\.com|images-amazon\.com|ssl-images-amazon\.com)$/.test(new URL(value).hostname)))].slice(0, 12);
  const variant = [...doc.querySelectorAll('#twister .selection, #twister .a-button-selected .a-button-text, #variation_size_name .selection, #variation_color_name .selection')].map((el) => el.textContent.trim()).filter(Boolean).join(" · ");
  return {
    asin: asin.toUpperCase(), title, brand: (doc.querySelector("#bylineInfo")?.textContent || "").trim().replace(/^Visit the (.+) Store$/i, "$1").replace(/^Brand:\s*/i, ""),
    category: breadcrumbs.join(" > ").slice(0, 200) || "Other", variant: variant.slice(0, 500),
    priceCents: cost?.unitPriceCents ?? 0, shippingCents: cost?.shippingCents ?? null,
    availability: available === "UNAVAILABLE" ? "UNAVAILABLE" : cost ? "AVAILABLE" : "UNKNOWN",
    images, bulletPoints, description: (doc.querySelector("#productDescription")?.textContent || "").trim().slice(0, 10000),
    source: "BROWSER", sourceUrl: `https://www.amazon.com/dp/${asin.toUpperCase()}`,
  };
};

globalThis.sellfinityCaptureBestsellers = function captureBestsellers(doc = document, url = location.href) {
  if (!/\/zgbs(?:\/|$)|\/Best-Sellers/i.test(new URL(url).pathname)) throw new Error("Open an Amazon Best Sellers category page.");
  const category = doc.querySelector("#zg_banner_text, #zg_browseRoot .zg_selected, h1")?.textContent?.trim() || doc.title;
  const cards = [...doc.querySelectorAll(".zg-grid-general-faceout, .p13n-sc-uncoverable-faceout")];
  const candidates = cards.flatMap((card) => {
    const anchor = [...card.querySelectorAll("a[href]")].find((link) => /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(link.href));
    const asin = anchor?.href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase();
    const rank = Number(card.querySelector(".zg-bdg-text")?.textContent?.replace(/[^0-9]/g, ""));
    if (!asin || !rank) return [];
    return [{ asin, amazonUrl: `https://www.amazon.com/dp/${asin}`, bestsellerRank: rank, bestsellerCategory: category.slice(0, 200), bestsellerUrl: url }];
  });
  if (!candidates.length) throw new Error("No ranked bestseller cards were readable. Check Amazon sign-in or CAPTCHA.");
  return [...new Map(candidates.map((row) => [row.asin, row])).values()];
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!["CAPTURE_CATALOG_PRODUCT", "CAPTURE_BESTSELLER_PAGE"].includes(message?.type)) return;
  try {
    sendResponse({ ok: true, result: message.type === "CAPTURE_CATALOG_PRODUCT" ? globalThis.sellfinityCaptureCatalogProduct() : globalThis.sellfinityCaptureBestsellers() });
  } catch (error) { sendResponse({ ok: false, error: error.message }); }
  return true;
});

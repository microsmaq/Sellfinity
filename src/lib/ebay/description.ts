export const EBAY_DESCRIPTION_MAX = 4000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainTextFromHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fit listing HTML within eBay Inventory API's 4,000-character limit.
 *
 * Gallery images are sent to eBay separately, so redundant inline images are
 * the first thing removed. If seller-authored HTML is still too large, it is
 * converted to a small, valid text-based HTML block instead of slicing tags in
 * half and sending malformed markup.
 */
export function fitEbayDescription(html: string): string {
  const compact = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .trim();
  if (compact.length <= EBAY_DESCRIPTION_MAX) return compact;

  const withoutInlineImages = compact
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<div\b[^>]*>\s*<\/div>/gi, "")
    .replace(/>\s+</g, "><")
    .trim();
  if (withoutInlineImages.length <= EBAY_DESCRIPTION_MAX) return withoutInlineImages;

  const prefix = '<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#111;">';
  const suffix = "</div>";
  const text = plainTextFromHtml(withoutInlineImages) || "Product details available in the listing.";

  let low = 1;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const shortened = middle < text.length ? `${text.slice(0, middle).trimEnd()}…` : text;
    const candidate = `${prefix}${escapeHtml(shortened)}${suffix}`;
    if (candidate.length <= EBAY_DESCRIPTION_MAX) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best || `${prefix}Product details available in the listing.${suffix}`;
}

/** Keep seller-authored shipping claims consistent with the actual eBay
 * fulfillment policy. This runs at publication and whenever a pricing action
 * changes the buyer shipping amount, so stale copy cannot contradict checkout. */
export function applyShippingStrategyToDescription(
  html: string,
  buyerShippingCents: number,
): string {
  const cents = Math.max(0, Math.round(buyerShippingCents));
  const withoutPreviousNotice = html.replace(
    /<div\b[^>]*id=["']sellfinity-shipping-notice["'][^>]*>[\s\S]*?<\/div>/gi,
    "",
  );
  const reconciled = cents > 0
    ? withoutPreviousNotice
        .replace(/\bfree\s+shipping\s+on\s+all\s+orders\b/gi, "Shipping charge is shown separately")
        .replace(/\b(?:fast\s+)?free\s+shipping\b/gi, "buyer-paid shipping")
        .replace(/\bshipping\s+(?:is\s+)?(?:free|included)\b/gi, "shipping is charged separately")
        .replace(/\bcomplimentary\s+shipping\b/gi, "buyer-paid shipping")
    : withoutPreviousNotice
        .replace(/\bbuyer[- ]paid\s+shipping\s+of\s+\$?\d+(?:\.\d{1,2})?\s+(?:applies\s+and\s+)?is\s+shown\s+separately(?:\s+at\s+checkout)?\b/gi, "free shipping is included")
        .replace(/\bbuyer[- ]paid\s+shipping\b/gi, "free shipping")
        .replace(/\bshipping\s+charge\s+(?:is\s+shown\s+separately|applies)\b/gi, "free shipping is included")
        .replace(/\bflat\s+\$?\d+(?:\.\d{1,2})?\s+shipping\b/gi, "free shipping");
  const message = cents > 0
    ? `<strong>Shipping:</strong> Buyer-paid shipping of $${(cents / 100).toFixed(2)} applies and is shown separately at checkout.`
    : "<strong>Shipping:</strong> FREE shipping is included with this item.";
  // Existing free-shipping templates already make the correct promise. Leave
  // them byte-for-byte stable so Smart Sync does not spend an eBay revision
  // call solely to add a duplicate notice.
  if (cents === 0 && /\bfree\s+shipping\b/i.test(reconciled)) {
    return fitEbayDescription(reconciled);
  }
  const notice = `<div id="sellfinity-shipping-notice" style="padding:12px 16px;background:#f0f8ff;border-bottom:1px solid #cfe8f7;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111;">${message}</div>`;
  return fitEbayDescription(`${notice}${reconciled}`);
}

/** Buyer-paid offers must not retain a promotional free-shipping title suffix. */
export function applyShippingStrategyToTitle(title: string, buyerShippingCents: number): string {
  if (buyerShippingCents <= 0) return title.trim();
  return title
    .replace(/\s*(?:[-–—|]\s*)?(?:fast\s+)?free\s+shipping\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s|–—-]+$/g, "")
    .trim();
}

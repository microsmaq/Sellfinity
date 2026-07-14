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

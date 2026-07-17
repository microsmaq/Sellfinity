import { EBAY_TITLE_MAX } from "@/lib/listings/generate";
import { fitEbayDescription } from "@/lib/ebay/description";
import type { ScrapedProduct } from "./scraper";

const SEO_SUFFIXES = [" - Brand New", " NEW"];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut.slice(0, max)).trim();
}

function cleanTitle(value: string): string {
  const words = value
    .replace(/amazon(?:'s)? choice/gi, "")
    .replace(/[|]+/g, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+[-–—]\s+/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");
  const seen = new Set<string>();
  return words
    .filter((word) => {
      const key = word.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(" ");
}

/** Keyword-dense eBay title: brand first when absent, duplicate/noise cleanup,
 * condition keyword when space permits, and a hard 80-character word cap. */
export function generateSeoTitle(scraped: { title: string; brand?: string }): string {
  let base = cleanTitle(scraped.title);
  const brand = cleanTitle(scraped.brand ?? "");
  if (brand && !base.toLowerCase().startsWith(brand.toLowerCase())) {
    base = `${brand} ${base}`;
  }
  for (const suffix of SEO_SUFFIXES) {
    if (base.length + suffix.length <= EBAY_TITLE_MAX) return base + suffix;
  }
  return truncateAtWord(base, EBAY_TITLE_MAX);
}

/** Amazon source title with only whitespace/noise cleanup and eBay's hard cap. */
export function generateSourceTitle(scraped: { title: string }): string {
  return truncateAtWord(scraped.title.replace(/\s+/g, " ").trim(), EBAY_TITLE_MAX);
}

function safeImages(urls: string[]): string[] {
  return [...new Set(urls)]
    .filter((url) => {
      try {
        return new URL(url).protocol === "https:";
      } catch {
        return false;
      }
    })
    .slice(0, 6);
}

/** eBay-safe, mobile-friendly HTML description based on the seller's chosen
 * blue bordered layout. All Amazon content is escaped before interpolation. */
export function generateMirrorDescription(
  scraped: Pick<
    ScrapedProduct,
    "title" | "brand" | "bulletPoints" | "description" | "category" | "imageUrls"
  >,
): string {
  const title = escapeHtml(scraped.title);
  const brand = escapeHtml(scraped.brand || "Unbranded");
  const category = escapeHtml(scraped.category);
  const features = scraped.bulletPoints
    .map((bullet) => bullet.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
  if (features.length === 0 && scraped.description.trim()) {
    features.push(scraped.description.replace(/\s+/g, " ").trim().slice(0, 1200));
  }
  const featureHtml = features
    .map((feature) => `<li style="margin:0 0 9px;">${escapeHtml(feature)}</li>`)
    .join("");
  const images = safeImages(scraped.imageUrls);
  const imageHtml = images.length
    ? `<div style="padding:18px 16px;text-align:center;border-top:1px solid #eee;">${images
        .map(
          (url, index) =>
            `<img src="${escapeHtml(url)}" alt="${title} - Product image ${index + 1}" style="display:inline-block;max-width:280px;width:46%;height:auto;margin:6px;border:1px solid #eee;border-radius:8px;vertical-align:middle;">`,
        )
        .join("")}</div>`
    : "";

  return fitEbayDescription(`<div style="font-family:Arial,Helvetica,sans-serif;max-width:950px;margin:0 auto;background:#fff;color:#111;border:3px solid #ccc;border-radius:15px;overflow:hidden;">
<div style="color:#058CD3;font-size:28px;font-weight:700;text-align:center;padding:18px 12px;border-bottom:1px solid #eee;">${title}</div>
${imageHtml}
<div style="padding:18px 22px;background:#fff;">
<div style="font-weight:700;color:#058CD3;font-size:20px;margin:0 0 10px;">Why You&#39;ll Love It</div>
<ul style="font-size:15px;line-height:1.65;color:#111;margin:0;padding-left:22px;">${featureHtml}</ul>
</div>
<div style="padding:14px 22px;border-top:1px solid #eee;background:#f8fbfd;font-size:14px;line-height:1.6;">
<strong style="color:#058CD3;">Brand:</strong> ${brand}<br>
<strong style="color:#058CD3;">Category:</strong> ${category}<br>
<strong style="color:#058CD3;">Condition:</strong> New
</div>
<div style="padding:14px 22px;font-size:14px;line-height:1.5;border-top:1px solid #ddd;background:#fafafa;">
<div style="font-weight:700;color:#058CD3;font-size:18px;margin:0 0 8px;">Shipping</div>
<ul style="margin:0 0 14px;padding-left:20px;"><li>FREE shipping on all orders</li><li>Ships within three business days</li><li>We ship to the lower 48 states only</li><li>Tracking is provided when available</li></ul>
<div style="font-weight:700;color:#058CD3;font-size:18px;margin:0 0 8px;">Returns</div>
<ul style="margin:0;padding-left:20px;"><li>30-day returns — item must be unused and in original packaging</li></ul>
</div>
<div style="text-align:center;padding:12px 16px;font-size:18px;font-weight:700;color:#058CD3;">Visit our eBay store for more great deals!</div>
<div style="text-align:center;padding:16px 12px;font-size:20px;font-weight:700;color:#058CD3;">Thank you!</div>
</div>`);
}

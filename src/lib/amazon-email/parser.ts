export type ParsedAmazonItem = { asin: string | null; title: string; quantity: number; unitPriceCents: number | null; amazonUrl: string | null };
export type ParsedAmazonEmail = {
  amazonOrderId: string; purchasedAt: Date | null; recipientName: string | null; deliveryAddressLine1: string | null; deliveryPostalCode: string | null; status: "ORDERED" | "SHIPPED" | "DELIVERED" | "CANCELLED";
  subtotalCents: number | null; shippingCents: number; taxCents: number; discountCents: number; totalCents: number | null;
  trackingNumber: string | null; carrier: string | null; trackingUrl: string | null; items: ParsedAmazonItem[];
};

function decodeEntities(value: string): string {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/&#x2F;/gi, "/").replace(/&#\d+;/g, " ");
}
function textFromHtml(html: string): string {
  return decodeEntities(html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>|<\/div>|<\/tr>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n");
}
function cents(value?: string): number | null {
  if (!value) return null;
  const number = Number(value.replace(/,/g, ""));
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}
function amount(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}\\s*:?\\s*(?:USD\\s*)?\\$([0-9,]+(?:\\.[0-9]{2})?)`, "i"));
    if (match) return cents(match[1]);
  }
  return null;
}

function amazonTrackingUrl(html: string): string | null {
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = textFromHtml(match[2]).trim();
    const href = decodeEntities(match[1]).trim();
    if (!/track(?: your)? package|shipment tracking|track shipment/i.test(label) && !/ship-track|progress-tracker|track(?:ing)?(?:id|number|package)/i.test(href)) continue;
    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "https:") continue;
      if (!/(^|\.)(?:amazon\.com|a\.co|amzn\.to|ups\.com|fedex\.com|usps\.com)$/i.test(parsed.hostname)) continue;
      return parsed.toString();
    } catch { /* Ignore malformed email links. */ }
  }
  return null;
}

function amazonHref(value: string): boolean {
  try {
    const parsed = new URL(value);
    return /(^|\.)amazon\.(?:com|ca|co\.uk)$/i.test(parsed.hostname);
  } catch {
    return value.startsWith("/");
  }
}

function asinFromHref(value: string): string | null {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt++) {
    const asin = decoded.match(/(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/i)?.[1];
    if (asin) return asin.toUpperCase();
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return null;
}

function recipientName(text: string): string | null {
  const patterns = [
    /(?:ship(?:ping)?|deliver(?:ing|ed)?)\s+to\s*:?\s*(?:\r?\n\s*)?([^\r\n|]{2,80})/i,
    /(?:recipient|addressee)\s*:\s*([^\r\n|]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const candidate = text.match(pattern)?.[1]
      ?.replace(/\s{2,}/g, " ")
      .replace(/\s+(?:order|address|estimated delivery).*$/i, "")
      .trim();
    if (candidate && /^[\p{L}][\p{L}\p{M}.'’ -]{1,79}$/u.test(candidate)) return candidate;
  }
  return null;
}

function deliveryAddress(text: string): { line1: string | null; postalCode: string | null } {
  const block = text.match(/(?:ship(?:ping)?|deliver(?:ing|ed)?)\s+to\s*:?\s*(?:\r?\n\s*)?([\s\S]{0,300})/i)?.[1];
  if (!block) return { line1: null, postalCode: null };
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
  // The first line is normally the recipient. Find the first subsequent line
  // beginning with a house number, PO box, or rural-route marker.
  const line1 = lines.slice(1).find((line) => /^(?:\d+[a-z]?\s|p\.?\s*o\.?\s+box\s|rr\s+\d)/i.test(line)) ?? null;
  const postalCode = block.match(/\b(\d{5}(?:-\d{4})?)\b/)?.[1] ?? null;
  return { line1, postalCode };
}

export function parseAmazonEmail(input: { subject: string; html?: string; text?: string; sentAt?: Date | null }): ParsedAmazonEmail | null {
  const html = input.html || "";
  const text = `${input.subject}\n${input.text || ""}\n${textFromHtml(html)}`;
  const orderId = text.match(/\b(\d{3}-\d{7}-\d{7})\b/)?.[1];
  if (!orderId) return null;
  const lower = `${input.subject} ${text.slice(0, 1000)}`.toLowerCase();
  const status = /cancel/.test(lower) ? "CANCELLED" : /deliver(?:ed|y confirmation)/.test(lower) ? "DELIVERED" : /ship(?:ped|ment)/.test(lower) ? "SHIPPED" : "ORDERED";
  const itemMap = new Map<string, ParsedAmazonItem>();
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    const href = decodeEntities(match[1]).trim();
    const asin = asinFromHref(href);
    const title = (textFromHtml(match[2]).trim() || match[2].match(/\balt=["']([^"']+)["']/i)?.[1] || "").trim();
    if (title.length < 8 || /amazon|view (?:your )?order|your orders|track (?:your )?package|order details|shop now|buy again/i.test(title)) continue;
    // Amazon's newer mail templates wrap product names in signed /gp/r.html
    // links. Those links often contain no visible ASIN, but the item name is
    // still useful and is intentionally retained for eBay-title matching.
    if (!asin && (!amazonHref(href) || !/\/gp\/r\.html|\/gp\/f\.html|\/hz\//i.test(href))) continue;
    const nearby = textFromHtml(html.slice(match.index || 0, (match.index || 0) + 800));
    const price = cents(nearby.match(/\$([0-9,]+(?:\.[0-9]{2})?)/)?.[1]);
    const quantity = Number(nearby.match(/(?:Qty|Quantity)\s*:?\s*(\d+)/i)?.[1] || 1);
    const key = asin ?? `title:${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
    itemMap.set(key, { asin, title: title.slice(0, 500), quantity, unitPriceCents: price, amazonUrl: asin ? `https://www.amazon.com/dp/${asin}` : null });
  }
  const subtotal = amount(text, ["Item\\(s\\) Subtotal", "Subtotal"]);
  const shipping = amount(text, ["Shipping & Handling", "Shipping"]) ?? 0;
  const tax = amount(text, ["Estimated tax to be collected", "Tax"]) ?? 0;
  const discount = amount(text, ["Promotion Applied", "Discount", "Gift Card Amount"]) ?? 0;
  const total = amount(text, ["Order Total", "Grand Total", "Total"]);
  const tracking = text.match(/(?:tracking(?: number| #)?|tracking id)\s*:?\s*([A-Z0-9-]{8,30})/i)?.[1] ?? null;
  const carrier = text.match(/(?:shipped via|carrier)\s*:?[ ]*(UPS|USPS|FedEx|Amazon Logistics)/i)?.[1] ?? null;
  const trackingUrl = amazonTrackingUrl(html);
  const address = deliveryAddress(text);
  return { amazonOrderId: orderId, purchasedAt: input.sentAt ?? null, recipientName: recipientName(text), deliveryAddressLine1: address.line1, deliveryPostalCode: address.postalCode, status, subtotalCents: subtotal, shippingCents: shipping, taxCents: tax, discountCents: discount, totalCents: total, trackingNumber: tracking, carrier, trackingUrl, items: [...itemMap.values()] };
}

export type ParsedAmazonItem = { asin: string | null; title: string; quantity: number; unitPriceCents: number | null; amazonUrl: string | null };
export type ParsedAmazonEmail = {
  amazonOrderId: string; purchasedAt: Date | null; status: "ORDERED" | "SHIPPED" | "DELIVERED" | "CANCELLED";
  subtotalCents: number | null; shippingCents: number; taxCents: number; discountCents: number; totalCents: number | null;
  trackingNumber: string | null; carrier: string | null; items: ParsedAmazonItem[];
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
    let href = decodeEntities(match[1]);
    try { href = decodeURIComponent(href); } catch { /* Keep the original URL. */ }
    const asin = href.match(/(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/i)?.[1]?.toUpperCase();
    if (!asin) continue;
    const title = (textFromHtml(match[2]).trim() || match[2].match(/\balt=["']([^"']+)["']/i)?.[1] || "").trim();
    if (title.length < 3 || /amazon|view order|track package/i.test(title)) continue;
    const nearby = textFromHtml(html.slice(match.index || 0, (match.index || 0) + 800));
    const price = cents(nearby.match(/\$([0-9,]+(?:\.[0-9]{2})?)/)?.[1]);
    const quantity = Number(nearby.match(/(?:Qty|Quantity)\s*:?\s*(\d+)/i)?.[1] || 1);
    itemMap.set(asin, { asin, title: title.slice(0, 500), quantity, unitPriceCents: price, amazonUrl: `https://www.amazon.com/dp/${asin}` });
  }
  const subtotal = amount(text, ["Item\\(s\\) Subtotal", "Subtotal"]);
  const shipping = amount(text, ["Shipping & Handling", "Shipping"]) ?? 0;
  const tax = amount(text, ["Estimated tax to be collected", "Tax"]) ?? 0;
  const discount = amount(text, ["Promotion Applied", "Discount", "Gift Card Amount"]) ?? 0;
  const total = amount(text, ["Order Total", "Grand Total", "Total"]);
  const tracking = text.match(/(?:tracking(?: number| #)?|tracking id)\s*:?\s*([A-Z0-9-]{8,30})/i)?.[1] ?? null;
  const carrier = text.match(/(?:shipped via|carrier)\s*:?[ ]*(UPS|USPS|FedEx|Amazon Logistics)/i)?.[1] ?? null;
  return { amazonOrderId: orderId, purchasedAt: input.sentAt ?? null, status, subtotalCents: subtotal, shippingCents: shipping, taxCents: tax, discountCents: discount, totalCents: total, trackingNumber: tracking, carrier, items: [...itemMap.values()] };
}

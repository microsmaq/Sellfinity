import type { CountdownBestSeller } from "./countdown";

export type BrowseBestSellerItem = {
  itemId?: string;
  legacyItemId?: string;
  title?: string;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  price?: { value?: string; currency?: string };
  condition?: string;
  seller?: {
    username?: string;
    feedbackPercentage?: string;
    feedbackScore?: number;
  };
  shippingOptions?: { shippingCost?: { value?: string } }[];
  estimatedAvailabilities?: { estimatedSoldQuantity?: number }[];
};

function cents(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

function numericItemId(item: BrowseBestSellerItem): string | null {
  if (item.legacyItemId?.trim()) return item.legacyItemId.trim();
  const composite = item.itemId?.trim();
  if (!composite) return null;
  const parts = composite.split("|");
  return parts.length >= 2 ? parts[1] : composite;
}

export function mapBrowseBestSellerItems(items: BrowseBestSellerItem[]): CountdownBestSeller[] {
  return items.flatMap((item, index) => {
    const itemId = numericItemId(item);
    const title = item.title?.trim();
    const priceCents = cents(item.price?.value);
    const quantitySold = Math.max(0, ...((item.estimatedAvailabilities ?? []).map(
      (availability) => Math.floor(Number(availability.estimatedSoldQuantity ?? 0)),
    )));
    if (!itemId || !title || priceCents <= 0 || quantitySold <= 0) return [];
    const shippingCents = cents(item.shippingOptions?.[0]?.shippingCost?.value);
    const feedback = Number(item.seller?.feedbackPercentage);
    const score = Number(item.seller?.feedbackScore);
    return [{
      itemId,
      title,
      url: item.itemWebUrl ?? `https://www.ebay.com/itm/${itemId}`,
      imageUrl: item.image?.imageUrl ?? "",
      priceCents,
      shippingCents,
      totalPriceCents: priceCents + shippingCents,
      quantitySold,
      condition: item.condition?.trim() || "Not specified",
      sellerName: item.seller?.username?.trim() || "Unknown seller",
      sellerFeedbackPct: Number.isFinite(feedback) ? feedback : null,
      sellerReviewCount: Number.isFinite(score) ? Math.max(0, Math.floor(score)) : null,
      hotness: "",
      sponsored: false,
      endedType: null,
      endedDate: null,
      sourcePosition: index + 1,
    } satisfies CountdownBestSeller];
  }).sort((a, b) => b.quantitySold - a.quantitySold || a.sourcePosition - b.sourcePosition);
}


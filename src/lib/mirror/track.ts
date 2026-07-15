// Match a live eBay listing to its Amazon source and start tracking it
// (margin display + inventory sync). Shared by the single and bulk actions.

import { db } from "@/lib/db";
import { estimateMargin } from "@/lib/fees";
import { LISTING_QUANTITY_CAP } from "@/lib/listings/generate";
import { serializeImageUrls } from "@/lib/types";
import { findAmazonMatch } from "./match";
import { resolveExactAmazonVariant } from "./variant";

export type TrackInput = {
  ebayListingId: string;
  title: string;
  priceCents: number;
  imageUrl: string | null;
  quantity: number | null;
};

export type TrackResult =
  | {
      ok: true;
      ebayListingId: string;
      match: {
        sku: string;
        amazonPriceCents: number;
        amazonUrl: string;
        profitCents: number;
        marginPct: number;
        unavailable: boolean;
      };
    }
  | { ok: false; ebayListingId: string; error: string };

export async function matchAndTrackListing(
  userId: string,
  input: TrackInput,
): Promise<TrackResult> {
  const fail = (error: string): TrackResult => ({
    ok: false,
    ebayListingId: input.ebayListingId,
    error,
  });

  const existing = await db.listing.findFirst({
    where: { userId, ebayListingId: input.ebayListingId },
  });
  if (existing) return fail("Already tracked.");

  const seed = await findAmazonMatch(input.title);
  if (!seed) return fail("No confident Amazon match.");
  const match = await resolveExactAmazonVariant(
    { title: input.title, imageUrl: input.imageUrl },
    seed,
  );
  if (!match) return fail("No exact, live-priced Amazon variant could be verified.");

  const images = input.imageUrl ? [input.imageUrl] : [];
  await db.$transaction(async (tx) => {
    const product = await tx.product.upsert({
      where: { userId_sku: { userId, sku: match.asin } },
      create: {
        userId,
        sku: match.asin,
        title: match.title,
        description: match.title,
        imageUrlsJson: serializeImageUrls(images),
        category: "Imported",
        supplierName: "Amazon",
        supplierProductId: match.asin,
        supplierUrl: match.url,
        costCents: match.priceCents,
        supplierStock: 50,
        shippingCostCents: 0,
        suggestedPriceCents: input.priceCents,
        sourceScore: 0,
      },
      update: {
        title: match.title,
        supplierProductId: match.asin,
        supplierUrl: match.url,
        costCents: match.priceCents,
        supplierStock: 50,
      },
    });
    await tx.listing.create({
      data: {
        userId,
        productId: product.id,
        title: input.title,
        description: input.title,
        priceCents: input.priceCents,
        quantity: Math.min(LISTING_QUANTITY_CAP, input.quantity ?? 1),
        imageUrlsJson: serializeImageUrls(images),
        status: "ACTIVE",
        ebayListingId: input.ebayListingId,
        publishedAt: new Date(),
      },
    });
  });

  const margin = estimateMargin(input.priceCents, match.priceCents, 0);
  return {
    ok: true,
    ebayListingId: input.ebayListingId,
    match: {
      sku: match.asin,
      amazonPriceCents: match.priceCents,
      amazonUrl: match.url,
      profitCents: margin.estimatedProfitCents,
      marginPct: Math.round(margin.marginPct),
      unavailable: false,
    },
  };
}

/**
 * Stop tracking a listing (e.g. the auto-match picked the wrong product).
 * Refused when the tracked listing has recorded sales — deleting it would
 * take P&L history with it.
 */
export async function untrackListing(
  userId: string,
  ebayListingId: string,
): Promise<{ error?: string }> {
  const listing = await db.listing.findFirst({
    where: { userId, ebayListingId },
    include: { _count: { select: { orders: true } }, product: true },
  });
  if (!listing) return { error: "Not tracked." };
  if (listing._count.orders > 0) {
    return { error: "This listing has recorded sales — unmatching would delete its profit history." };
  }
  await db.listing.delete({ where: { id: listing.id } });
  // Remove the product too if nothing else references it.
  const siblings = await db.listing.count({ where: { productId: listing.productId } });
  if (siblings === 0) {
    await db.product.delete({ where: { id: listing.productId } });
  }
  return {};
}

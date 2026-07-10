"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { EbayApiError } from "@/lib/ebay/client";
import { findAmazonMatch } from "@/lib/mirror/match";
import { LISTING_QUANTITY_CAP } from "@/lib/listings/generate";
import { serializeImageUrls } from "@/lib/types";

export type EbayListingResult = { error?: string };

function revalidate() {
  revalidatePath("/listings");
  revalidatePath("/inventory");
  revalidatePath("/dashboard");
}

/**
 * Find and store the Amazon counterpart of a live eBay listing, so it gets
 * margin tracking and inventory sync like app-created listings. With real
 * data configured this costs one Rainforest credit.
 */
export async function matchEbayListing(input: {
  ebayListingId: string;
  title: string;
  priceCents: number;
  imageUrl: string | null;
  quantity: number | null;
}): Promise<EbayListingResult> {
  const user = await requireUser();

  const existing = await db.listing.findFirst({
    where: { userId: user.id, ebayListingId: input.ebayListingId },
  });
  if (existing) return { error: "This listing is already tracked." };

  const match = await findAmazonMatch(input.title);
  if (!match) {
    return {
      error: "No confident Amazon match found for this listing's title.",
    };
  }

  const images = input.imageUrl ? [input.imageUrl] : [];
  await db.$transaction(async (tx) => {
    // The matched Amazon product may already be in this user's inventory
    // (e.g. mirrored earlier); reuse it rather than duplicating the SKU.
    const product =
      (await tx.product.findUnique({
        where: { userId_sku: { userId: user.id, sku: match.asin } },
      })) ??
      (await tx.product.create({
        data: {
          userId: user.id,
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
      }));
    await tx.listing.create({
      data: {
        userId: user.id,
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

  revalidate();
  return {};
}

/** Revise the price of a live eBay listing (any origin). */
export async function repriceEbayListing(
  ebayListingId: string,
  priceCents: number,
): Promise<EbayListingResult> {
  const user = await requireUser();
  if (priceCents < 99) return { error: "Price must be at least $0.99" };

  const client = await getEbayClientForUser(user.id);
  try {
    await client.updateListing(ebayListingId, { priceCents });
  } catch (e) {
    if (e instanceof EbayApiError) return { error: e.message };
    throw e;
  }
  await db.listing.updateMany({
    where: { userId: user.id, ebayListingId },
    data: { priceCents },
  });
  revalidate();
  return {};
}

/** End a live eBay listing (any origin). */
export async function endEbayListing(
  ebayListingId: string,
): Promise<EbayListingResult> {
  const user = await requireUser();
  const client = await getEbayClientForUser(user.id);
  try {
    await client.endListing(ebayListingId);
  } catch (e) {
    if (e instanceof EbayApiError) return { error: e.message };
    throw e;
  }
  await db.listing.updateMany({
    where: { userId: user.id, ebayListingId },
    data: { status: "ENDED", endedAt: new Date() },
  });
  revalidate();
  return {};
}

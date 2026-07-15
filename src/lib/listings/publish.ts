import "server-only";

import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { EbayApiError, validateListingInput } from "@/lib/ebay/client";
import { fitEbayDescription } from "@/lib/ebay/description";
import { parseImageUrls } from "@/lib/types";

export type PublishOneResult =
  | { ok: true; ebayListingId: string }
  | { ok: false; error: string };

/** Publish one locally-created draft through the user's connected eBay
 * account. Shared by normal Listings publishing and direct mirror batches. */
export async function publishListingForUser(
  userId: string,
  listingId: string,
): Promise<PublishOneResult> {
  const connection = await db.ebayConnection.findUnique({ where: { userId } });
  if (!connection || connection.status === "DISCONNECTED") {
    return { ok: false, error: "Connect your eBay account in Settings before publishing." };
  }

  const draft = await db.listing.findFirst({
    where: { id: listingId, userId, status: "DRAFT" },
    include: { product: true },
  });
  if (!draft) return { ok: false, error: "The mirrored draft is no longer available." };

  const input = {
    title: draft.title,
    description: fitEbayDescription(draft.description),
    priceCents: draft.priceCents,
    quantity: draft.quantity,
    imageUrls: parseImageUrls(draft.imageUrlsJson),
    sku: draft.product.sku,
    category: draft.product.category,
  };
  const validationError = validateListingInput(input);
  if (validationError) return { ok: false, error: validationError };

  try {
    const client = await getEbayClientForUser(userId);
    const { ebayListingId } = await client.createListing(input);
    await db.listing.update({
      where: { id: draft.id },
      data: { status: "ACTIVE", ebayListingId, publishedAt: new Date() },
    });
    return { ok: true, ebayListingId };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof EbayApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "eBay publication failed.",
    };
  }
}

/** A direct-publish failure must not leave a draft behind. Preserve any
 * pre-existing product, but remove the newly-created product when orphaned. */
export async function discardFailedMirrorDraft(
  userId: string,
  listingId: string,
): Promise<void> {
  const listing = await db.listing.findFirst({
    where: { id: listingId, userId, status: "DRAFT" },
    select: { id: true, productId: true },
  });
  if (!listing) return;
  await db.listing.delete({ where: { id: listing.id } });
  const remaining = await db.listing.count({ where: { productId: listing.productId } });
  if (remaining === 0) {
    await db.product.delete({ where: { id: listing.productId } });
  }
}

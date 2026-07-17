"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { EbayApiError } from "@/lib/ebay/client";
import { generateListing } from "@/lib/listings/generate";
import { parseImageUrls } from "@/lib/types";
import { publishListingForUser } from "@/lib/listings/publish";
import { recordListingActivity } from "@/lib/listings/activity-history";

export type BulkResult = { done: number; failed: number; error?: string };

function revalidate() {
  revalidatePath("/listings");
  revalidatePath("/dashboard");
  revalidatePath("/inventory");
}

/** Generate draft listings for products that don't already have an open listing. */
export async function createDrafts(productIds: string[]): Promise<BulkResult> {
  const user = await requireUser();
  if (productIds.length === 0) return { done: 0, failed: 0, error: "Nothing selected" };

  const products = await db.product.findMany({
    where: { id: { in: productIds }, userId: user.id },
    include: { listings: { where: { status: { in: ["DRAFT", "ACTIVE"] } } } },
  });

  let done = 0;
  let failed = 0;
  for (const product of products) {
    if (product.listings.length > 0) {
      failed++; // already has an open listing
      continue;
    }
    const content = generateListing({
      title: product.title,
      description: product.description,
      category: product.category,
      imageUrls: parseImageUrls(product.imageUrlsJson),
      suggestedPriceCents: product.suggestedPriceCents,
      supplierStock: product.supplierStock,
    });
    await db.listing.create({
      data: {
        userId: user.id,
        productId: product.id,
        title: content.title,
        description: content.description,
        priceCents: content.priceCents,
        quantity: content.quantity,
        imageUrlsJson: JSON.stringify(content.imageUrls),
        status: "DRAFT",
      },
    });
    done++;
  }
  revalidate();
  return { done, failed };
}

/** Publish drafts to eBay. Requires a connected eBay account. */
export async function publishListings(listingIds: string[]): Promise<BulkResult> {
  const user = await requireUser();
  if (listingIds.length === 0) return { done: 0, failed: 0, error: "Nothing selected" };

  const connection = await db.ebayConnection.findUnique({ where: { userId: user.id } });
  if (!connection || connection.status === "DISCONNECTED") {
    return {
      done: 0,
      failed: listingIds.length,
      error: "Connect your eBay account in Settings before publishing.",
    };
  }

  let done = 0;
  let failed = 0;
  let firstError: string | undefined;
  const listings = await db.listing.findMany({
    where: { id: { in: listingIds }, userId: user.id },
    include: { product: true },
  });
  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  const activity: Parameters<typeof recordListingActivity>[0]["items"] = [];

  for (const listingId of listingIds) {
    const result = await publishListingForUser(user.id, listingId);
    if (result.ok) done++;
    else {
      failed++;
      firstError ??= result.error;
    }
    const listing = byId.get(listingId);
    activity.push({
      title: listing?.title ?? `Listing ${listingId}`,
      listingId,
      ebayListingId: result.ok ? result.ebayListingId : listing?.ebayListingId,
      amazonUrl: listing?.product.supplierUrl,
      sourcePriceCents: listing?.product.costCents,
      listingPriceCents: listing?.priceCents,
      ok: result.ok,
      error: result.ok ? null : result.error,
    });
  }

  await recordListingActivity({ userId: user.id, source: "LISTING_PUBLISH", items: activity });

  revalidate();
  return { done, failed, error: firstError };
}

/** End active listings on eBay. */
export async function endListings(listingIds: string[]): Promise<BulkResult> {
  const user = await requireUser();
  const listings = await db.listing.findMany({
    where: { id: { in: listingIds }, userId: user.id, status: "ACTIVE" },
    include: { product: true },
  });
  const client = await getEbayClientForUser(user.id);
  let done = 0;
  for (const listing of listings) {
    if (listing.ebayListingId) await client.endListing(listing.ebayListingId);
    await db.listing.update({
      where: { id: listing.id },
      data: { status: "ENDED", endedAt: new Date() },
    });
    done++;
  }
  await recordListingActivity({
    userId: user.id,
    source: "LISTING_END",
    items: listings.map((listing) => ({
      title: listing.title,
      listingId: listing.id,
      ebayListingId: listing.ebayListingId,
      amazonUrl: listing.product.supplierUrl,
      sourcePriceCents: listing.product.costCents,
      listingPriceCents: listing.priceCents,
      ok: true,
    })),
  });
  revalidate();
  return { done, failed: listings.length - done };
}

/** Delete draft listings (drafts only — live listings must be ended). */
export async function deleteDrafts(listingIds: string[]): Promise<BulkResult> {
  const user = await requireUser();
  const { count } = await db.listing.deleteMany({
    where: { id: { in: listingIds }, userId: user.id, status: "DRAFT" },
  });
  revalidate();
  return { done: count, failed: 0 };
}

/** Update price and/or quantity; revises the live eBay listing when active. */
export async function updateListing(
  listingId: string,
  update: { priceCents?: number; quantity?: number },
): Promise<BulkResult> {
  const user = await requireUser();
  if (update.priceCents !== undefined && update.priceCents < 99) {
    return { done: 0, failed: 1, error: "Price must be at least $0.99" };
  }
  if (update.quantity !== undefined && update.quantity < 0) {
    return { done: 0, failed: 1, error: "Quantity cannot be negative" };
  }
  const listing = await db.listing.findFirst({
    where: { id: listingId, userId: user.id, status: { in: ["DRAFT", "ACTIVE"] } },
    include: { product: true },
  });
  if (!listing) return { done: 0, failed: 1, error: "Listing not found" };

  if (listing.status === "ACTIVE" && listing.ebayListingId) {
    try {
      const client = await getEbayClientForUser(user.id);
      await client.updateListing(listing.ebayListingId, update);
    } catch (e) {
      if (e instanceof EbayApiError) {
        await recordListingActivity({
          userId: user.id,
          source: "LISTING_EDIT",
          items: [{
            title: listing.title,
            listingId: listing.id,
            ebayListingId: listing.ebayListingId,
            amazonUrl: listing.product.supplierUrl,
            sourcePriceCents: listing.product.costCents,
            listingPriceCents: update.priceCents ?? listing.priceCents,
            ok: false,
            error: e.message,
          }],
        });
        return { done: 0, failed: 1, error: e.message };
      }
      throw e;
    }
  }
  await db.listing.update({ where: { id: listing.id }, data: update });
  await recordListingActivity({
    userId: user.id,
    source: "LISTING_EDIT",
    items: [{
      title: listing.title,
      listingId: listing.id,
      ebayListingId: listing.ebayListingId,
      amazonUrl: listing.product.supplierUrl,
      sourcePriceCents: listing.product.costCents,
      listingPriceCents: update.priceCents ?? listing.priceCents,
      ok: true,
    }],
  });
  revalidate();
  return { done: 1, failed: 0 };
}

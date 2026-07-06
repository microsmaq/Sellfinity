"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEbayClient } from "@/lib/ebay";
import { EbayApiError, validateListingInput } from "@/lib/ebay/client";
import { generateListing } from "@/lib/listings/generate";
import { planFor, remainingListingSlots } from "@/lib/plans";
import { parseImageUrls } from "@/lib/types";

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

/** Publish drafts to eBay. Enforces eBay connection and plan listing limits. */
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

  const activeCount = await db.listing.count({
    where: { userId: user.id, status: "ACTIVE" },
  });
  const slots = remainingListingSlots(user.plan, activeCount);
  const drafts = await db.listing.findMany({
    where: { id: { in: listingIds }, userId: user.id, status: "DRAFT" },
    include: { product: true },
  });
  if (drafts.length > slots) {
    const planName = planFor(user.plan).name;
    return {
      done: 0,
      failed: drafts.length,
      error: `Your ${planName} plan allows ${slots} more active listing${slots === 1 ? "" : "s"} (${drafts.length} selected). Upgrade in Billing to publish more.`,
    };
  }

  const client = getEbayClient();
  let done = 0;
  let failed = 0;
  let firstError: string | undefined;

  for (const draft of drafts) {
    const input = {
      title: draft.title,
      description: draft.description,
      priceCents: draft.priceCents,
      quantity: draft.quantity,
      imageUrls: parseImageUrls(draft.imageUrlsJson),
      sku: draft.product.sku,
      category: draft.product.category,
    };
    const validationError = validateListingInput(input);
    if (validationError) {
      failed++;
      firstError ??= `${draft.title.slice(0, 40)}…: ${validationError}`;
      continue;
    }
    try {
      const { ebayListingId } = await client.createListing(input);
      // Claim a plan slot atomically — the upfront check can race a
      // concurrent publish, so the activation re-counts inside a transaction.
      const claimed = await db.$transaction(async (tx) => {
        const nowActive = await tx.listing.count({
          where: { userId: user.id, status: "ACTIVE" },
        });
        if (remainingListingSlots(user.plan, nowActive) < 1) return false;
        await tx.listing.update({
          where: { id: draft.id },
          data: { status: "ACTIVE", ebayListingId, publishedAt: new Date() },
        });
        return true;
      });
      if (!claimed) {
        await client.endListing(ebayListingId);
        failed++;
        firstError ??= "Plan listing limit reached. Upgrade in Billing to publish more.";
        continue;
      }
      done++;
    } catch (e) {
      failed++;
      if (e instanceof EbayApiError) firstError ??= e.message;
      else throw e;
    }
  }

  revalidate();
  return { done, failed, error: firstError };
}

/** End active listings on eBay. */
export async function endListings(listingIds: string[]): Promise<BulkResult> {
  const user = await requireUser();
  const listings = await db.listing.findMany({
    where: { id: { in: listingIds }, userId: user.id, status: "ACTIVE" },
  });
  const client = getEbayClient();
  let done = 0;
  for (const listing of listings) {
    if (listing.ebayListingId) await client.endListing(listing.ebayListingId);
    await db.listing.update({
      where: { id: listing.id },
      data: { status: "ENDED", endedAt: new Date() },
    });
    done++;
  }
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
  });
  if (!listing) return { done: 0, failed: 1, error: "Listing not found" };

  if (listing.status === "ACTIVE" && listing.ebayListingId) {
    try {
      await getEbayClient().updateListing(listing.ebayListingId, update);
    } catch (e) {
      if (e instanceof EbayApiError) return { done: 0, failed: 1, error: e.message };
      throw e;
    }
  }
  await db.listing.update({ where: { id: listing.id }, data: update });
  revalidate();
  return { done: 1, failed: 0 };
}

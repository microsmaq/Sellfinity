"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { EbayApiError } from "@/lib/ebay/client";
import {
  matchAndTrackListing,
  untrackListing,
  type TrackInput,
  type TrackResult,
} from "@/lib/mirror/track";
import { classifyListing } from "@/lib/listings/cleanup";
import { estimateMargin } from "@/lib/fees";

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
export async function matchEbayListing(input: TrackInput): Promise<TrackResult> {
  const user = await requireUser();
  const result = await matchAndTrackListing(user.id, input);
  revalidate();
  return result;
}

/** How many listings one batch call processes (stays well under the
 * serverless time limit; the client loops batches for Match-all). */
const MATCH_BATCH_SIZE = 10;
const MATCH_CONCURRENCY = 5;

/** Match a batch of listings; the client drives successive batches. */
export async function matchEbayListingsBatch(
  items: TrackInput[],
): Promise<TrackResult[]> {
  const user = await requireUser();
  const batch = items.slice(0, MATCH_BATCH_SIZE);
  const results: TrackResult[] = [];
  for (let i = 0; i < batch.length; i += MATCH_CONCURRENCY) {
    const slice = batch.slice(i, i + MATCH_CONCURRENCY);
    results.push(
      ...(await Promise.all(slice.map((item) => matchAndTrackListing(user.id, item)))),
    );
  }
  revalidate();
  return results;
}

/** Undo a (mis)match: stop tracking the listing on the app side. */
export async function unmatchEbayListing(
  ebayListingId: string,
): Promise<EbayListingResult> {
  const user = await requireUser();
  const result = await untrackListing(user.id, ebayListingId);
  revalidate();
  return result;
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

export type CleanupItemResult = {
  ebayListingId: string;
  action: "ok" | "repriced" | "ended" | "error";
  newPriceCents?: number;
  profitCents?: number;
  marginPct?: number;
  error?: string;
};

/** How many listings one clean-up batch call processes. */
const CLEANUP_BATCH_SIZE = 10;

/**
 * Clean up a batch of tracked listings: raise prices to the 30%-margin /
 * $7-profit target (whichever is cheaper), end listings whose margin is
 * beyond -30%. The client loops batches with progress.
 */
export async function cleanupEbayListings(
  ebayListingIds: string[],
): Promise<CleanupItemResult[]> {
  const user = await requireUser();
  const client = await getEbayClientForUser(user.id);
  const results: CleanupItemResult[] = [];

  for (const ebayListingId of ebayListingIds.slice(0, CLEANUP_BATCH_SIZE)) {
    const listing = await db.listing.findFirst({
      where: { userId: user.id, ebayListingId, status: "ACTIVE" },
      include: { product: true },
    });
    if (!listing) {
      results.push({ ebayListingId, action: "error", error: "Not tracked/active" });
      continue;
    }
    const decision = classifyListing(
      listing.priceCents,
      listing.product.costCents,
      listing.product.shippingCostCents,
    );
    try {
      if (decision.action === "reprice") {
        await client.updateListing(ebayListingId, {
          priceCents: decision.newPriceCents,
        });
        await db.listing.update({
          where: { id: listing.id },
          data: { priceCents: decision.newPriceCents },
        });
        const margin = estimateMargin(
          decision.newPriceCents,
          listing.product.costCents,
          listing.product.shippingCostCents,
        );
        results.push({
          ebayListingId,
          action: "repriced",
          newPriceCents: decision.newPriceCents,
          profitCents: margin.estimatedProfitCents,
          marginPct: Math.round(margin.marginPct),
        });
      } else if (decision.action === "end") {
        await client.endListing(ebayListingId);
        await db.listing.update({
          where: { id: listing.id },
          data: { status: "ENDED", endedAt: new Date() },
        });
        results.push({ ebayListingId, action: "ended" });
      } else {
        results.push({ ebayListingId, action: "ok" });
      }
    } catch (e) {
      results.push({
        ebayListingId,
        action: "error",
        error: e instanceof EbayApiError ? e.message.slice(0, 150) : "failed",
      });
    }
  }
  revalidate();
  return results;
}

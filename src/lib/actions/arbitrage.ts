"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { buildOpportunityRows } from "@/lib/arbitrage/rows";
import type { OpportunityRow } from "@/lib/arbitrage/scanner";
import { getScraper } from "@/lib/mirror";
import { mirrorUrl, type MirrorOutcome } from "@/lib/mirror/pipeline";

/** Re-scan with a larger count ("Load 50 more"); globally profit-sorted. */
export async function loadOpportunities(count: number): Promise<OpportunityRow[]> {
  const user = await requireUser();
  return buildOpportunityRows(user.id, count);
}

/**
 * Mirror an arbitrage opportunity's Amazon product into the user's store,
 * pricing the draft against the known eBay comp instead of an estimate.
 */
export async function mirrorOpportunity(
  asin: string,
  ebayPriceCents: number,
): Promise<MirrorOutcome> {
  const user = await requireUser();
  const outcome = await mirrorUrl(
    user.id,
    `https://www.amazon.com/dp/${asin}`,
    getScraper(),
    { marketPriceCents: ebayPriceCents },
  );
  revalidatePath("/arbitrage");
  revalidatePath("/listings");
  return outcome;
}

export type BulkMirrorResult = {
  mirroredAsins: string[];
  failed: number;
  error?: string;
};

/** Bulk-mirror selected opportunities (up to 50 per call). */
export async function mirrorOpportunities(
  items: { asin: string; ebayPriceCents: number }[],
): Promise<BulkMirrorResult> {
  const user = await requireUser();
  const mirroredAsins: string[] = [];
  let failed = 0;
  let firstError: string | undefined;

  for (const item of items.slice(0, 50)) {
    const outcome = await mirrorUrl(
      user.id,
      `https://www.amazon.com/dp/${item.asin}`,
      getScraper(),
      { marketPriceCents: item.ebayPriceCents },
    );
    if (outcome.ok) mirroredAsins.push(item.asin);
    else {
      failed++;
      firstError ??= outcome.error;
    }
  }
  revalidatePath("/arbitrage");
  revalidatePath("/listings");
  return { mirroredAsins, failed, error: firstError };
}

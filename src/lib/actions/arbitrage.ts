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

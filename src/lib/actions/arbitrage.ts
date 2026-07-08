"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getScraper } from "@/lib/mirror";
import { mirrorUrl, type MirrorOutcome } from "@/lib/mirror/pipeline";

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

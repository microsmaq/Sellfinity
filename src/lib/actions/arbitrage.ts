"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { scanMore } from "@/lib/arbitrage";
import {
  listArbitragePage,
  type ArbitragePage,
  type ArbitragePageParams,
} from "@/lib/arbitrage/store";
import type { ScanReport } from "@/lib/arbitrage/scan-types";
import { getScraper } from "@/lib/mirror";
import { mirrorUrl, type MirrorOutcome } from "@/lib/mirror/pipeline";

/** One page of the research database (filters/sort/pagination server-side). */
export async function fetchArbitragePage(
  params: ArbitragePageParams,
): Promise<ArbitragePage> {
  const user = await requireUser();
  return listArbitragePage(user.id, params);
}

/** Advance the scan now ("add more to the database"). Each call is
 * time-boxed; the client loops until its target is reached. */
export async function scanForNew(target = 50): Promise<ScanReport> {
  await requireUser();
  const report = await scanMore({ target: Math.min(Math.max(1, target), 50) });
  revalidatePath("/arbitrage");
  return report;
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

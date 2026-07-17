"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { mirrorUrl, parseUrlLines, type MirrorOutcome } from "@/lib/mirror/pipeline";
import { publishListings, type BulkResult } from "./listings";

/** Bulk ceiling per request — keeps a pasted dump from hogging the server. */
const MAX_URLS_PER_BATCH = 50;

export type MirrorResult = {
  outcomes: MirrorOutcome[];
  /** Result of the immediate publish, when requested. */
  publish?: BulkResult;
  error?: string;
};

/**
 * Mirror one or many Amazon product URLs into draft listings; optionally
 * publish them to eBay immediately (plan limits and the eBay connection
 * requirement apply through the normal publish path).
 */
export async function mirrorUrls(
  input: string,
  publishNow: boolean,
): Promise<MirrorResult> {
  const user = await requireUser();
  const urls = parseUrlLines(input, MAX_URLS_PER_BATCH);
  if (urls.length === 0) {
    return { outcomes: [], error: "Paste at least one Amazon product URL." };
  }

  const outcomes: MirrorOutcome[] = [];
  for (const url of urls) {
    outcomes.push(await mirrorUrl(user.id, url, undefined, {
      improveMainImage: user.improveMainImage,
      improveListingContent: user.improveListingContent,
    }));
  }

  let publish: BulkResult | undefined;
  if (publishNow) {
    const listingIds = outcomes
      .filter((o) => o.ok && o.listingId)
      .map((o) => o.listingId!);
    if (listingIds.length > 0) {
      publish = await publishListings(listingIds);
    }
  }

  revalidatePath("/listings");
  revalidatePath("/mirror");
  return { outcomes, publish };
}

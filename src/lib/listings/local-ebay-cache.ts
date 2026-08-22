import type { RemoteListing } from "@/lib/ebay/client";
import { parseImageUrls } from "@/lib/types";

export type RetainedEbayListing = {
  ebayListingId: string | null;
  status: string;
  title: string;
  priceCents: number;
  quantity: number;
  imageUrlsJson: string;
  publishedAt: Date | null;
  updatedAt: Date;
};

export type RetainedEbaySnapshot = RemoteListing & {
  updatedAt: Date;
};

/**
 * Build the Listings-page eBay view entirely from records retained after
 * successful eBay writes. This intentionally performs no network request.
 */
export function retainedEbayListings(
  listings: RetainedEbayListing[],
  suppressedEbayIds: ReadonlySet<string>,
  ebayItemHost: string,
  snapshots: RetainedEbaySnapshot[] = [],
): RemoteListing[] {
  const localByEbayId = new Map(listings.flatMap((listing) =>
    listing.ebayListingId ? [[listing.ebayListingId, listing] as const] : [],
  ));
  const retained = new Map<string, { listing: RemoteListing; updatedAt: Date }>();

  for (const snapshot of snapshots) {
    if (suppressedEbayIds.has(snapshot.ebayListingId)) continue;
    const local = localByEbayId.get(snapshot.ebayListingId);
    if (local && local.status !== "ACTIVE") continue;
    retained.set(snapshot.ebayListingId, { listing: snapshot, updatedAt: snapshot.updatedAt });
  }

  for (const listing of listings) {
    if (listing.status !== "ACTIVE" || !listing.ebayListingId || suppressedEbayIds.has(listing.ebayListingId)) continue;
    const existing = retained.get(listing.ebayListingId);
    if (existing && existing.updatedAt > listing.updatedAt) continue;
    retained.set(listing.ebayListingId, {
      updatedAt: listing.updatedAt,
      listing: {
        ebayListingId: listing.ebayListingId,
        title: listing.title,
        priceCents: listing.priceCents,
        url: `${ebayItemHost}/itm/${listing.ebayListingId}`,
        imageUrl: parseImageUrls(listing.imageUrlsJson)[0] ?? null,
        quantity: listing.quantity,
        listingDate: listing.publishedAt,
      },
    });
  }

  return [...retained.values()].map((entry) => entry.listing);
}

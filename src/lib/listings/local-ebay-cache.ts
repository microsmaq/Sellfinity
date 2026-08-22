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
};

/**
 * Build the Listings-page eBay view entirely from records retained after
 * successful eBay writes. This intentionally performs no network request.
 */
export function retainedEbayListings(
  listings: RetainedEbayListing[],
  suppressedEbayIds: ReadonlySet<string>,
  ebayItemHost: string,
): RemoteListing[] {
  return listings.flatMap((listing) =>
    listing.status === "ACTIVE" &&
    listing.ebayListingId &&
    !suppressedEbayIds.has(listing.ebayListingId)
      ? [{
          ebayListingId: listing.ebayListingId,
          title: listing.title,
          priceCents: listing.priceCents,
          url: `${ebayItemHost}/itm/${listing.ebayListingId}`,
          imageUrl: parseImageUrls(listing.imageUrlsJson)[0] ?? null,
          quantity: listing.quantity,
          listingDate: listing.publishedAt,
        }]
      : [],
  );
}

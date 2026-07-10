// Assemble the "Active on eBay" repricer rows: the live eBay listing set
// joined with locally tracked products for margin data.

import { estimateMargin } from "@/lib/fees";
import type { RemoteListing } from "@/lib/ebay/client";
import type { EbayRow } from "@/app/(app)/listings/ebay-listings-table";

export type LocalListingFacts = {
  ebayListingId: string | null;
  status: string;
  imageUrlsJson: string;
  product: {
    sku: string;
    costCents: number;
    shippingCostCents: number;
    supplierStock: number;
    supplierUrl: string;
  };
};

function firstImage(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as string[];
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}

export function buildEbayRows(
  remote: RemoteListing[],
  local: LocalListingFacts[],
): EbayRow[] {
  const byEbayId = new Map(
    local.filter((l) => l.ebayListingId).map((l) => [l.ebayListingId!, l]),
  );

  const rows: EbayRow[] = [];
  for (const r of remote) {
    const localListing = byEbayId.get(r.ebayListingId);
    // eBay's "active" list lags reality by minutes-to-hours; if we ended a
    // listing ourselves, trust our own record and hide it immediately.
    if (localListing?.status === "ENDED") continue;

    if (!localListing) {
      rows.push({
        ebayListingId: r.ebayListingId,
        title: r.title,
        priceCents: r.priceCents,
        url: r.url,
        imageUrl: r.imageUrl,
        quantity: r.quantity,
        match: null,
      });
      continue;
    }
    const margin = estimateMargin(
      r.priceCents,
      localListing.product.costCents,
      localListing.product.shippingCostCents,
    );
    rows.push({
      ebayListingId: r.ebayListingId,
      title: r.title,
      priceCents: r.priceCents,
      url: r.url,
      imageUrl: r.imageUrl ?? firstImage(localListing.imageUrlsJson),
      quantity: r.quantity,
      match: {
        sku: localListing.product.sku,
        amazonPriceCents: localListing.product.costCents,
        amazonUrl: localListing.product.supplierUrl,
        profitCents: margin.estimatedProfitCents,
        marginPct: Math.round(margin.marginPct),
        unavailable: localListing.product.supplierStock === 0,
      },
    });
  }

  // Problems first: unavailable, then unprofitable, then unmatched, then
  // thinnest margins.
  return rows.sort((a, b) => {
    const rank = (r: EbayRow) =>
      !r.match ? 2 : r.match.unavailable ? 0 : r.match.profitCents <= 0 ? 1 : 3;
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (a.match?.profitCents ?? 0) - (b.match?.profitCents ?? 0);
  });
}

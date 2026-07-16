import {
  TARGET_MARGIN,
  TARGET_PROFIT_CENTS,
  trueProfitCents,
} from "@/lib/listings/cleanup";

export type ListingHealthStatus =
  | "SOURCE_ISSUE"
  | "UNPROFITABLE"
  | "THIN_MARGIN"
  | "MARKET_DATA_NEEDED"
  | "COMPETITIVE"
  | "ABOVE_MARKET";

export type ListingHealth = {
  status: ListingHealthStatus;
  label: string;
  profitCents: number | null;
  marginPct: number | null;
  benchmarkPriceCents: number | null;
  priceDifferencePct: number | null;
};

type HealthListing = {
  priceCents: number;
  match: {
    amazonPriceCents: number;
    shippingCostCents: number;
    unavailable: boolean;
  } | null;
  market: {
    bestSellingPriceCents: number;
  } | null;
};

export function assessListingHealth(listing: HealthListing): ListingHealth {
  const benchmarkPriceCents = listing.market?.bestSellingPriceCents ?? null;
  if (!listing.match || listing.match.unavailable) {
    return {
      status: "SOURCE_ISSUE",
      label: listing.match ? "Amazon unavailable" : "Source needs review",
      profitCents: null,
      marginPct: null,
      benchmarkPriceCents,
      priceDifferencePct: null,
    };
  }

  const profitCents = trueProfitCents(
    listing.priceCents,
    listing.match.amazonPriceCents,
    listing.match.shippingCostCents,
  );
  const marginPct =
    listing.priceCents > 0
      ? Math.round((profitCents / listing.priceCents) * 100)
      : 0;
  if (profitCents <= 0) {
    return {
      status: "UNPROFITABLE",
      label: "Unprofitable",
      profitCents,
      marginPct,
      benchmarkPriceCents,
      priceDifferencePct: null,
    };
  }
  if (
    marginPct < TARGET_MARGIN * 100 &&
    profitCents < TARGET_PROFIT_CENTS
  ) {
    return {
      status: "THIN_MARGIN",
      label: "Thin margin",
      profitCents,
      marginPct,
      benchmarkPriceCents,
      priceDifferencePct: null,
    };
  }
  if (!benchmarkPriceCents || benchmarkPriceCents <= 0) {
    return {
      status: "MARKET_DATA_NEEDED",
      label: "Market data needed",
      profitCents,
      marginPct,
      benchmarkPriceCents: null,
      priceDifferencePct: null,
    };
  }

  const priceDifferencePct = Math.round(
    ((listing.priceCents - benchmarkPriceCents) / benchmarkPriceCents) * 100,
  );
  if (listing.priceCents <= benchmarkPriceCents) {
    return {
      status: "COMPETITIVE",
      label: "Competitive",
      profitCents,
      marginPct,
      benchmarkPriceCents,
      priceDifferencePct,
    };
  }
  return {
    status: "ABOVE_MARKET",
    label: `${priceDifferencePct}% above est. best seller`,
    profitCents,
    marginPct,
    benchmarkPriceCents,
    priceDifferencePct,
  };
}

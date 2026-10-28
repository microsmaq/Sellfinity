import { requireUser } from "@/lib/auth";
import {
  listArbitragePage,
  type ArbitragePageParams,
} from "@/lib/arbitrage/store";
import { PageHeader } from "@/components/ui";
import { ArbitrageTable } from "./arbitrage-table";

export const metadata = { title: "Arbitrage finder — Sellfinity" };

export default async function ArbitragePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const raw = await searchParams;
  const sortKeys: ArbitragePageParams["sortKey"][] = [
    "profit", "margin", "ebayPrice", "amazonPrice", "sales", "competition",
    "avgCompPrice", "recommendedPrice", "suggestedPrice", "matchConfidence",
    "usersListed", "priceAssessment", "researched", "amazonTitle", "category", "newest",
  ];
  const rawSort = typeof raw.sort === "string" ? raw.sort : "profit";
  const rawMatch = typeof raw.match === "string" ? raw.match.toUpperCase() : "ALL";
  const number = (value: string | string[] | undefined, max: number) => typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Math.min(max, Math.max(0, Number(value))) : 0;
  const optionalNumber = (value: string | string[] | undefined, max: number) => typeof value === "string" && value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.min(max, Number(value)) : undefined;
  const params: ArbitragePageParams = {
    page: Math.max(1, Number(raw.page ?? 1) || 1),
    pageSize: [25, 50, 100, 250, 500, 1_000].includes(Number(raw.pageSize))
      ? Number(raw.pageSize)
      : 50,
    sortKey: sortKeys.includes(rawSort as ArbitragePageParams["sortKey"])
      ? (rawSort as ArbitragePageParams["sortKey"])
      : "profit",
    sortDesc: raw.dir !== "asc",
    category: typeof raw.category === "string" ? raw.category : "all",
    minMarginPct: Math.max(0, Number(raw.minMargin ?? 0) || 0),
    minConfidence: Math.max(0, Number(raw.minConfidence ?? 0) || 0),
    matchVerdict: ["ALL", "MATCH", "LIKELY", "REVIEW"].includes(rawMatch)
      ? (rawMatch as ArbitragePageParams["matchVerdict"])
      : "ALL",
    qualifiedOnly: raw.qualified === "1" || raw.qualified === "true",
    unlistedOnly: raw.unlisted === "1" || raw.unlisted === "true",
    minSales: Math.floor(number(raw.minSales, 1000000)),
    minUsers: Math.floor(number(raw.minUsers, 1000000)),
    minEbayPriceCents: Math.round(number(raw.minPrice, 1000000) * 100),
    maxEbayPriceCents: Math.round(number(raw.maxPrice, 1000000) * 100),
    minAmazonLandedCents: Math.round(number(raw.minAmazon, 1000000) * 100),
    maxAmazonLandedCents: optionalNumber(raw.maxAmazon, 1000000) == null ? undefined : Math.round(optionalNumber(raw.maxAmazon, 1000000)! * 100),
    minProfitCents: Math.round(number(raw.minProfit, 1000000) * 100) || undefined,
    maxCompetitors: optionalNumber(raw.maxCompetitors, 1000000) == null ? undefined : Math.floor(optionalNumber(raw.maxCompetitors, 1000000)!),
    priceAssessment: typeof raw.assessment === "string" && ["Highly competitive", "Competitive", "Near market", "Above market", "High premium", "Not rated"].includes(raw.assessment) ? raw.assessment : "ALL",
    query: typeof raw.q === "string" ? raw.q : "",
  };
  const data = await listArbitragePage(user.id, params);

  return (
    <>
      <PageHeader
        title="Arbitrage finder"
        subtitle="Admin-curated Amazon bestsellers with verified eBay equivalents, competitive market data, and margins net of eBay fees."
      />
      <ArbitrageTable
        data={data}
        filters={params}
        sitewideDiscountBps={user.ebaySitewideDiscountBps}
      />
    </>
  );
}

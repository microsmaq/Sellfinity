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
    "usersListed", "researched", "amazonTitle", "category", "newest",
  ];
  const rawSort = typeof raw.sort === "string" ? raw.sort : "profit";
  const rawMatch = typeof raw.match === "string" ? raw.match.toUpperCase() : "ALL";
  const params: ArbitragePageParams = {
    page: Math.max(1, Number(raw.page ?? 1) || 1),
    pageSize: [25, 50, 100].includes(Number(raw.pageSize))
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
    query: typeof raw.q === "string" ? raw.q : "",
  };
  const data = await listArbitragePage(user.id, params);

  return (
    <>
      <PageHeader
        title="Arbitrage finder"
        subtitle="Admin-curated Amazon bestsellers with verified eBay equivalents, competitive market data, and margins net of eBay fees."
      />
      <ArbitrageTable data={data} filters={params} />
    </>
  );
}

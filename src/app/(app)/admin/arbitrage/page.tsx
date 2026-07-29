import { requireAdmin } from "@/lib/auth";
import {
  listAdminCatalog,
  type AdminCatalogFilters,
  type AdminCatalogSortKey,
  type AdminCatalogStatus,
} from "@/lib/arbitrage/admin-catalog";
import { PageHeader } from "@/components/ui";
import { AdminArbitrageManager } from "./admin-arbitrage-manager";

export const metadata = { title: "Arbitrage administration — Sellfinity" };
export const maxDuration = 300;

export default async function AdminArbitragePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const query = typeof params.q === "string" ? params.q : "";
  const rawStatus =
    typeof params.status === "string" ? params.status.toUpperCase() : "ALL";
  const status: AdminCatalogStatus = [
    "ALL",
    "PENDING",
    "PUBLISHED",
    "NO_MATCH",
    "ARCHIVED",
  ].includes(rawStatus)
    ? (rawStatus as AdminCatalogStatus)
    : "ALL";
  const rawSort = typeof params.sort === "string" ? params.sort : "newest";
  const sortKeys: AdminCatalogSortKey[] = [
    "newest",
    "amazonTitle",
    "category",
    "amazonPrice",
    "ebayPrice",
    "matchConfidence",
    "averagePrice",
    "recommendedPrice",
    "suggestedPrice",
    "sales",
    "competition",
    "profit",
    "margin",
    "usersListed",
    "researched",
  ];
  const source =
    typeof params.source === "string" &&
    ["ALL", "BESTSELLER", "ADMIN"].includes(params.source.toUpperCase())
      ? (params.source.toUpperCase() as AdminCatalogFilters["source"])
      : "ALL";
  const ebayMatch =
    typeof params.ebayMatch === "string" &&
    ["ALL", "MATCHED", "UNMATCHED"].includes(params.ebayMatch.toUpperCase())
      ? (params.ebayMatch.toUpperCase() as AdminCatalogFilters["ebayMatch"])
      : "ALL";
  const matchVerdict =
    typeof params.match === "string" &&
    ["ALL", "MATCH", "LIKELY", "REVIEW", "REJECTED", "UNVERIFIED"].includes(
      params.match.toUpperCase(),
    )
      ? params.match.toUpperCase()
      : "ALL";
  const filters: AdminCatalogFilters = {
    query,
    status,
    category: typeof params.category === "string" ? params.category : "ALL",
    matchVerdict,
    source,
    ebayMatch,
    minMargin: Math.max(0, Number(params.minMargin ?? 0) || 0),
    minConfidence: Math.max(0, Number(params.minConfidence ?? 0) || 0),
    qualifiedOnly:
      params.qualified === "1" || params.qualified === "true",
    sortKey: sortKeys.includes(rawSort as AdminCatalogSortKey)
      ? (rawSort as AdminCatalogSortKey)
      : "newest",
    sortDesc: params.dir !== "asc",
    pageSize: [25, 50, 100].includes(Number(params.pageSize))
      ? Number(params.pageSize)
      : 50,
  };
  const data = await listAdminCatalog({ page, filters });

  return (
    <>
      <PageHeader
        title="Arbitrage catalog administration"
        subtitle="Curate Amazon bestsellers, verify equivalent eBay products, and control exactly which researched opportunities sellers receive."
      />
      <AdminArbitrageManager
        data={data}
        filters={filters}
      />
    </>
  );
}

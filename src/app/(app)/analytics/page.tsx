import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { getProductAnalyticsOverview } from "@/lib/analytics/product-overview";
import { ProductAnalyticsDashboard } from "./product-analytics-dashboard";
import { AdminCatalogTable } from "./admin-catalog-table";
import { db } from "@/lib/db";

export const metadata = { title: "Product analytics — Sellfinity" };

function validDate(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ? null : value;
}

export default async function ProductAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const admin = user.role === "ADMIN";
  const raw = await searchParams;
  const today = new Date();
  const defaultEnd = today.toISOString().slice(0, 10);
  const defaultStartDate = new Date(today);
  defaultStartDate.setUTCDate(defaultStartDate.getUTCDate() - 29);
  const requestedStart = validDate(raw.from) ?? defaultStartDate.toISOString().slice(0, 10);
  const requestedEnd = validDate(raw.to) ?? defaultEnd;
  let startDate = requestedStart <= requestedEnd ? requestedStart : requestedEnd;
  let endDate = requestedEnd >= requestedStart ? requestedEnd : requestedStart;
  if (endDate > defaultEnd) endDate = defaultEnd;
  if (startDate > defaultEnd) startDate = defaultEnd;
  const earliestDate = new Date(`${endDate}T00:00:00.000Z`);
  earliestDate.setUTCDate(earliestDate.getUTCDate() - 89);
  const earliest = earliestDate.toISOString().slice(0, 10);
  if (startDate < earliest) startDate = earliest;
  const overview = await getProductAnalyticsOverview({
    userId: admin ? undefined : user.id,
    includeCatalog: false,
    startDate: new Date(`${startDate}T00:00:00.000Z`),
    endDate: new Date(`${endDate}T23:59:59.999Z`),
  });

  const search = typeof raw.catalogSearch === "string" ? raw.catalogSearch.trim().slice(0, 120) : "";
  const catalogSort = typeof raw.catalogSort === "string" && ["title", "activity", "suggested", "competitor"].includes(raw.catalogSort) ? raw.catalogSort : "title";
  const catalogPage = typeof raw.catalogPage === "string" && /^\d+$/.test(raw.catalogPage) ? Math.max(1, Math.min(100000, Number(raw.catalogPage))) : 1;
  const where = search ? { OR: [{ asin: { contains: search, mode: "insensitive" as const } }, { amazonTitle: { contains: search, mode: "insensitive" as const } }] } : {};
  const catalogOrder = catalogSort === "activity" ? { updatedAt: "desc" as const } : catalogSort === "suggested" ? { suggestedPriceCents: "desc" as const } : catalogSort === "competitor" ? { averageCompetitorPriceCents: "desc" as const } : { amazonTitle: "asc" as const };
  const [catalogCount, matchingCount, catalogRows] = admin ? await Promise.all([
    db.adminArbitrageProduct.count(),
    db.adminArbitrageProduct.count({ where }),
    db.adminArbitrageProduct.findMany({ where, select: { asin: true, amazonTitle: true, amazonImageUrl: true, category: true, suggestedPriceCents: true, averageCompetitorPriceCents: true, updatedAt: true }, orderBy: [catalogOrder, { asin: "asc" }], skip: (catalogPage - 1) * 50, take: 50 }),
  ]) : [0, 0, []];
  if (admin) overview.totals.productCount = catalogCount;

  return (
    <>
      <PageHeader
        title={admin ? "Admin product analytics" : "Product analytics"}
        subtitle={admin
          ? "Performance across the complete product catalog and every seller who mirrored each ASIN."
          : "Sales, profit, listing activity, and performance for every product you mirrored."}
      />
      <ProductAnalyticsDashboard overview={overview} admin={admin} startDate={startDate} endDate={endDate} />
      {admin && <AdminCatalogTable rows={catalogRows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))} count={matchingCount} page={catalogPage} search={search} sort={catalogSort} startDate={startDate} endDate={endDate} />}
    </>
  );
}

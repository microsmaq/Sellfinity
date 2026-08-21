import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { getProductAnalyticsOverview } from "@/lib/analytics/product-overview";
import { ProductAnalyticsDashboard } from "./product-analytics-dashboard";

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
    includeCatalog: admin,
    startDate: new Date(`${startDate}T00:00:00.000Z`),
    endDate: new Date(`${endDate}T23:59:59.999Z`),
  });

  return (
    <>
      <PageHeader
        title={admin ? "Admin product analytics" : "Product analytics"}
        subtitle={admin
          ? "Performance across the complete product catalog and every seller who mirrored each ASIN."
          : "Sales, profit, listing activity, and performance for every product you mirrored."}
      />
      <ProductAnalyticsDashboard overview={overview} admin={admin} startDate={startDate} endDate={endDate} />
    </>
  );
}

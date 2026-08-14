import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { getProductAnalyticsOverview } from "@/lib/analytics/product-overview";
import { ProductAnalyticsDashboard } from "./product-analytics-dashboard";

export const metadata = { title: "Product analytics — Sellfinity" };

export default async function ProductAnalyticsPage() {
  const user = await requireUser();
  const admin = user.role === "ADMIN";
  const overview = await getProductAnalyticsOverview({
    userId: admin ? undefined : user.id,
    includeCatalog: admin,
    days: 30,
  });

  return (
    <>
      <PageHeader
        title={admin ? "Admin product analytics" : "Product analytics"}
        subtitle={admin
          ? "Performance across the complete product catalog and every seller who mirrored each ASIN."
          : "Sales, profit, listing activity, and performance for every product you mirrored."}
      />
      <ProductAnalyticsDashboard overview={overview} admin={admin} />
    </>
  );
}

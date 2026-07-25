import { requireAdmin } from "@/lib/auth";
import {
  listAdminCatalog,
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
  const data = await listAdminCatalog({ page, query, status });

  return (
    <>
      <PageHeader
        title="Arbitrage catalog administration"
        subtitle="Curate Amazon bestsellers, verify equivalent eBay products, and control exactly which researched opportunities sellers receive."
      />
      <AdminArbitrageManager
        data={data}
        query={query}
        status={status}
      />
    </>
  );
}

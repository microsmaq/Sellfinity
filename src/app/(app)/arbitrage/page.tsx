import { requireUser } from "@/lib/auth";
import { listArbitragePage } from "@/lib/arbitrage/store";
import { PageHeader } from "@/components/ui";
import { ArbitrageTable } from "./arbitrage-table";

export const metadata = { title: "Arbitrage finder — Sellfinity" };

// Manual scans call paid external APIs; give the action room to run.
export const maxDuration = 60;

export default async function ArbitragePage() {
  const user = await requireUser();
  const initial = await listArbitragePage(user.id, {
    page: 1,
    pageSize: 25,
    sortKey: "profit",
    sortDesc: true,
    category: "all",
    minMarginPct: 0,
    query: "",
  });

  return (
    <>
      <PageHeader
        title="Arbitrage finder"
        subtitle="Admin-curated Amazon bestsellers with verified eBay equivalents, competitive market data, and margins net of eBay fees."
      />
      <ArbitrageTable
        initial={initial}
        initialAutoPublish={user.autoPublishArbitrage}
        canManageData={user.role === "ADMIN"}
      />
    </>
  );
}

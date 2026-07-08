import { requireUser } from "@/lib/auth";
import { buildOpportunityRows } from "@/lib/arbitrage/rows";
import { PageHeader } from "@/components/ui";
import { ArbitrageTable } from "./arbitrage-table";

export const metadata = { title: "Arbitrage finder — Sellfinity" };

const INITIAL_COUNT = 50;

export default async function ArbitragePage() {
  const user = await requireUser();
  const rows = await buildOpportunityRows(user.id, INITIAL_COUNT);

  return (
    <>
      <PageHeader
        title="Arbitrage finder"
        subtitle="Best-selling eBay products with a cheaper Amazon source right now — margins shown net of eBay fees. Refreshes daily."
      />
      <ArbitrageTable initialRows={rows} />
    </>
  );
}

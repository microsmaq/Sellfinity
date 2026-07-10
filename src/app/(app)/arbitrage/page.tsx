import { requireUser } from "@/lib/auth";
import { buildOpportunityRows } from "@/lib/arbitrage/rows";
import { PageHeader } from "@/components/ui";
import { ArbitrageTable } from "./arbitrage-table";

export const metadata = { title: "Arbitrage finder — Sellfinity" };

// Real scans call paid external APIs; allow time for the first scan of the
// day and keep the initial page conservative (Load more extends it).
export const maxDuration = 60;

const INITIAL_COUNT = 20;

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

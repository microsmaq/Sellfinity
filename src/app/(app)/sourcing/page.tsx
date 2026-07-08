import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSupplierProvider } from "@/lib/sourcing";
import { scoreAndRank } from "@/lib/sourcing/scoring";
import { PageHeader } from "@/components/ui";
import { SourcingTable, type CandidateRow } from "./sourcing-table";

export const metadata = { title: "Product sourcing — Sellfinity" };

export default async function SourcingPage() {
  const user = await requireUser();
  const [candidates, products] = await Promise.all([
    getSupplierProvider().getTrendingCandidates(),
    db.product.findMany({ where: { userId: user.id }, select: { sku: true } }),
  ]);
  const importedSkus = new Set(products.map((p) => p.sku));
  const scored = scoreAndRank(candidates);

  const rows: CandidateRow[] = scored.map((c) => ({
    id: c.supplierProductId,
    title: c.title,
    category: c.category,
    imageUrl: c.imageUrls[0] ?? null,
    supplierName: c.supplierName,
    costCents: c.costCents,
    marketPriceCents: c.marketPriceCents,
    estimatedProfitCents: c.margin.estimatedProfitCents,
    marginPct: Math.round(c.margin.marginPct),
    salesPerWeek: c.salesPerWeek,
    competitorCount: c.competitorCount,
    stock: c.stock,
    score: c.score,
    imported: importedSkus.has(c.supplierProductId),
  }));

  const categories = [...new Set(rows.map((r) => r.category))].sort();

  return (
    <>
      <PageHeader
        title="Product sourcing"
        subtitle={`Today's feed: ${rows.length} candidates from ${scored[0]?.supplierName ?? "suppliers"}, ranked by margin, demand, and competition. Refreshes daily.`}
      />
      <SourcingTable rows={rows} categories={categories} />
    </>
  );
}

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getArbitrageScanner } from "@/lib/arbitrage";
import { PageHeader } from "@/components/ui";
import { ArbitrageTable, type OpportunityRow } from "./arbitrage-table";

export const metadata = { title: "Arbitrage finder — Sellfinity" };

export default async function ArbitragePage() {
  const user = await requireUser();
  const [opportunities, products] = await Promise.all([
    getArbitrageScanner().findOpportunities(),
    db.product.findMany({ where: { userId: user.id }, select: { sku: true } }),
  ]);
  const ownedSkus = new Set(products.map((p) => p.sku));

  const rows: OpportunityRow[] = opportunities.map((o) => ({
    asin: o.amazon.asin,
    category: o.category,
    title: o.ebay.title,
    imageUrl: o.ebay.imageUrl,
    ebayPriceCents: o.ebay.priceCents,
    ebaySales30d: o.ebay.salesLast30d,
    ebayUrl: o.ebay.url,
    amazonPriceCents: o.amazon.priceCents,
    amazonUrl: o.amazon.url,
    profitCents: o.margin.estimatedProfitCents,
    marginPct: Math.round(o.margin.marginPct),
    feeCents: o.margin.estimatedFeeCents,
    mirrored: ownedSkus.has(o.amazon.asin),
  }));

  const categories = [...new Set(rows.map((r) => r.category))].sort();

  return (
    <>
      <PageHeader
        title="Arbitrage finder"
        subtitle={`${rows.length} best-selling eBay products with a cheaper Amazon source right now — margins shown net of eBay fees. Refreshes daily.`}
      />
      <ArbitrageTable rows={rows} categories={categories} />
    </>
  );
}

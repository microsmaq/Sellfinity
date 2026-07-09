import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseImageUrls } from "@/lib/types";
import { PageHeader, Badge } from "@/components/ui";
import { ListingsView, type ListingRow, type UnlistedRow } from "./listings-view";

export const metadata = { title: "Listings — Sellfinity" };

export default async function ListingsPage() {
  const user = await requireUser();

  const [products, listings, connection] = await Promise.all([
    db.product.findMany({
      where: { userId: user.id },
      include: { listings: { where: { status: { in: ["DRAFT", "ACTIVE"] } } } },
      orderBy: { createdAt: "desc" },
    }),
    db.listing.findMany({
      where: { userId: user.id },
      include: { product: { select: { sku: true, costCents: true } } },
      orderBy: { updatedAt: "desc" },
    }),
    db.ebayConnection.findUnique({ where: { userId: user.id } }),
  ]);

  const unlisted: UnlistedRow[] = products
    .filter((p) => p.listings.length === 0)
    .map((p) => ({
      productId: p.id,
      sku: p.sku,
      title: p.title,
      imageUrl: parseImageUrls(p.imageUrlsJson)[0] ?? null,
      costCents: p.costCents,
      suggestedPriceCents: p.suggestedPriceCents,
      supplierStock: p.supplierStock,
    }));

  const rows: ListingRow[] = listings.map((l) => ({
    id: l.id,
    title: l.title,
    sku: l.product.sku,
    imageUrl: parseImageUrls(l.imageUrlsJson)[0] ?? null,
    priceCents: l.priceCents,
    quantity: l.quantity,
    costCents: l.product.costCents,
    status: l.status as "DRAFT" | "ACTIVE" | "ENDED",
    ebayListingId: l.ebayListingId,
    publishedAt: l.publishedAt?.toISOString() ?? null,
  }));

  const ebayConnected = !!connection && connection.status !== "DISCONNECTED";

  return (
    <>
      <PageHeader
        title="Listings"
        subtitle="Generate listing drafts from your sourced inventory, then publish to eBay in bulk."
        actions={
          <Badge tone={ebayConnected ? "green" : "amber"}>
            {ebayConnected
              ? `eBay: ${connection?.ebayUsername ?? "connected"} (sandbox)`
              : "eBay not connected"}
          </Badge>
        }
      />
      <ListingsView
        unlisted={unlisted}
        listings={rows}
        ebayConnected={ebayConnected}
      />
    </>
  );
}

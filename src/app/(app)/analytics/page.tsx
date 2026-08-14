/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, EmptyState, PageHeader, Badge } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { parseImageUrls } from "@/lib/types";

export const metadata = { title: "Product analytics — Sellfinity" };

export default async function ProductAnalyticsPage() {
  const user = await requireUser();
  const products = await db.product.findMany({
    where: { userId: user.id, listings: { some: {} } },
    include: { listings: { include: { orders: true } } },
    orderBy: { createdAt: "desc" },
  });
  const rows = products.map((product) => {
    const orders = product.listings.flatMap((listing) => listing.orders).filter((order) => order.status !== "REFUNDED");
    return {
      asin: product.supplierProductId,
      title: product.title,
      imageUrl: parseImageUrls(product.imageUrlsJson)[0] ?? null,
      active: product.listings.filter((listing) => listing.status === "ACTIVE").length,
      listings: product.listings.length,
      units: orders.reduce((sum, order) => sum + order.quantity, 0),
      revenueCents: orders.reduce((sum, order) => sum + order.salePriceCents * order.quantity + order.shippingChargedCents, 0),
    };
  });
  return (
    <>
      <PageHeader title="Product analytics" subtitle="Sales, price history, and eBay buyer traffic for each Amazon product you mirrored." />
      {rows.length === 0 ? <EmptyState title="No mirrored products yet" body="Mirror an Amazon product or publish one from the Arbitrage Finder to begin tracking performance." action={<Link href="/mirror" className="text-sm font-medium text-indigo-600">Mirror a product →</Link>} /> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{rows.map((row) => <Link key={row.asin} href={`/analytics/asins/${encodeURIComponent(row.asin)}`} className="group"><Card className="h-full p-5 transition group-hover:border-indigo-300 group-hover:shadow-md"><div className="flex gap-3">{row.imageUrl ? <img src={row.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-lg border border-slate-200 object-contain" /> : <div className="h-16 w-16 rounded-lg bg-slate-100" />}<div className="min-w-0"><p className="line-clamp-2 font-semibold text-slate-900 group-hover:text-indigo-700">{row.title}</p><p className="mt-1 text-xs text-slate-500">{row.asin}</p></div></div><div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-4 text-center"><div><p className="text-lg font-semibold">{row.units}</p><p className="text-[11px] text-slate-500">Units sold</p></div><div><p className="text-lg font-semibold">{formatCents(row.revenueCents)}</p><p className="text-[11px] text-slate-500">Revenue</p></div><div><Badge tone={row.active ? "green" : "slate"}>{row.active}/{row.listings} active</Badge></div></div></Card></Link>)}</div>}
    </>
  );
}

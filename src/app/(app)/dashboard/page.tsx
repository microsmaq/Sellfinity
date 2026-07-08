import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { dailySeries, perItem, summarize, windowStartUtc } from "@/lib/orders/stats";
import { Card, EmptyState, PageHeader, StatCard } from "@/components/ui";
import { ProfitChart } from "./profit-chart";
import { ImportOrdersButton } from "./import-orders-button";

export const metadata = { title: "Profit dashboard — Sellfinity" };

export default async function DashboardPage() {
  const user = await requireUser();

  const orders = await db.order.findMany({
    where: { userId: user.id },
    include: {
      listing: {
        select: {
          product: { select: { id: true, title: true, sku: true } },
        },
      },
    },
    orderBy: { saleDate: "desc" },
  });

  const cutoff30 = windowStartUtc(30);
  const last30 = orders.filter((o) => o.saleDate >= cutoff30);
  const totals30 = summarize(last30);
  const totalsAll = summarize(orders);
  const series = dailySeries(last30, 30);
  const items = perItem(
    orders.map((o) => ({
      ...o,
      productId: o.listing.product.id,
      title: o.listing.product.title,
      sku: o.listing.product.sku,
    })),
  );

  const marginPct =
    totals30.revenueCents > 0
      ? ((totals30.netCents / totals30.revenueCents) * 100).toFixed(1)
      : null;

  return (
    <>
      <PageHeader
        title="Profit dashboard"
        subtitle="Revenue, fees, and cost of goods across your eBay sales — what you actually kept."
        actions={<ImportOrdersButton />}
      />

      {orders.length === 0 ? (
        <EmptyState
          title="No sales recorded yet"
          body="Publish listings and import your eBay orders to see profit here. In sandbox mode, active listings generate sample sales you can import."
          action={
            <Link href="/listings" className="text-sm font-medium text-indigo-600">
              Go to Listings →
            </Link>
          }
        />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Revenue (30d)"
              value={formatCents(totals30.revenueCents)}
              sub={`${totals30.orders} orders · ${totals30.units} units`}
            />
            <StatCard
              label="eBay fees (30d)"
              value={formatCents(totals30.feesCents)}
              tone="negative"
            />
            <StatCard
              label="Goods + shipping (30d)"
              value={formatCents(totals30.cogsCents)}
              tone="negative"
            />
            <StatCard
              label="Net profit (30d)"
              value={formatCents(totals30.netCents)}
              sub={marginPct ? `${marginPct}% margin · ${formatCents(totalsAll.netCents)} all-time` : undefined}
              tone={totals30.netCents >= 0 ? "positive" : "negative"}
            />
          </div>

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">
              Daily net profit — last 30 days
            </h2>
            <ProfitChart points={series} />
          </Card>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-slate-900">
              Profit by item (all time)
            </h2>
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3 text-right">Units</th>
                    <th className="px-4 py-3 text-right">Revenue</th>
                    <th className="px-4 py-3 text-right">Fees</th>
                    <th className="px-4 py-3 text-right">Goods + ship</th>
                    <th className="px-4 py-3 text-right">Net profit</th>
                    <th className="px-4 py-3 text-right">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.productId} className="border-b border-slate-100 last:border-0">
                      <td className="max-w-md px-4 py-3">
                        <p className="truncate font-medium text-slate-900" title={item.title}>
                          {item.title}
                        </p>
                        <p className="text-xs text-slate-500">SKU {item.sku}</p>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{item.units}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCents(item.revenueCents)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                        {formatCents(item.feesCents)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                        {formatCents(item.cogsCents)}
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-medium tabular-nums ${item.netCents >= 0 ? "text-emerald-600" : "text-red-600"}`}
                      >
                        {formatCents(item.netCents)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {item.revenueCents > 0
                          ? `${((item.netCents / item.revenueCents) * 100).toFixed(0)}%`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Recent orders</h2>
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Order</th>
                    <th className="px-4 py-3">Item</th>
                    <th className="px-4 py-3">Buyer</th>
                    <th className="px-4 py-3 text-right">Qty</th>
                    <th className="px-4 py-3 text-right">Sale</th>
                    <th className="px-4 py-3 text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.slice(0, 15).map((o) => {
                    const revenue = o.salePriceCents * o.quantity + o.shippingChargedCents;
                    const net = revenue - o.ebayFeeCents - o.cogsCents - o.shippingCostCents;
                    return (
                      <tr key={o.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-3 whitespace-nowrap">
                          {o.saleDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500">{o.ebayOrderId}</td>
                        <td className="max-w-xs px-4 py-3">
                          <p className="truncate" title={o.listing.product.title}>
                            {o.listing.product.title}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-slate-500">{o.buyerUsername}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{o.quantity}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{formatCents(revenue)}</td>
                        <td
                          className={`px-4 py-3 text-right font-medium tabular-nums ${net >= 0 ? "text-emerald-600" : "text-red-600"}`}
                        >
                          {o.status === "REFUNDED" ? "Refunded" : formatCents(net)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          </section>
        </div>
      )}
    </>
  );
}

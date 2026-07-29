import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { refreshAdminEbayMarket } from "@/lib/arbitrage/admin-research";

export const maxDuration = 300;

type RefreshBody = {
  cursor?: string;
  batchSize?: number;
};

/** Admin-only, resumable eBay/AI refresh. This path never calls the Amazon
 * scraper or Rainforest; profitability uses the catalog's stored Amazon cost
 * and shipping snapshot. */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as RefreshBody;
  const batchSize = Math.max(1, Math.min(10, Math.round(body.batchSize ?? 5)));
  const where = {
    ebayItemId: { not: null as null },
    ebayTitle: { not: null as null },
    ebayPriceCents: { not: null as null },
    ...(body.cursor ? { id: { gt: body.cursor } } : {}),
  };
  const rows = await db.adminArbitrageProduct.findMany({
    where,
    orderBy: { id: "asc" },
    take: batchSize,
    select: { id: true, asin: true },
  });
  const settled = await Promise.allSettled(
    rows.map((row) => refreshAdminEbayMarket(row.id)),
  );
  const results = settled.map((result, index) =>
    result.status === "fulfilled"
      ? { ok: true as const, ...result.value }
      : {
          ok: false as const,
          asin: rows[index].asin,
          error:
            result.reason instanceof Error
              ? result.reason.message.slice(0, 180)
              : "Refresh failed",
        },
  );
  const nextCursor = rows.at(-1)?.id ?? body.cursor ?? null;
  const remaining = nextCursor
    ? await db.adminArbitrageProduct.count({
        where: {
          ebayItemId: { not: null },
          ebayTitle: { not: null },
          ebayPriceCents: { not: null },
          id: { gt: nextCursor },
        },
      })
    : 0;

  return NextResponse.json({
    processed: rows.length,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    nextCursor,
    remaining,
    done: rows.length === 0 || remaining === 0,
    results,
    rainforestRequests: 0,
  });
}

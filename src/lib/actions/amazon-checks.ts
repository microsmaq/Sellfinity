"use server";

import { z } from "zod";
import { requireAdmin, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

/** Shared ASIN attempt bookkeeping never changes price or availability. */
export async function recordAmazonCheckAttempt(rawIds: string[], scope: "ADMIN" | "LISTINGS") {
  const ids = z.array(z.string().min(1).max(100)).min(1).max(1000).parse([...new Set(rawIds)]);
  z.enum(["ADMIN", "LISTINGS"]).parse(scope);
  let asins: string[];
  if (scope === "ADMIN") {
    await requireAdmin();
    const rows = await db.adminArbitrageProduct.findMany({ where: { id: { in: ids } }, select: { asin: true } });
    asins = rows.map((row) => row.asin);
  } else {
    const user = await requireUser();
    const rows = await db.listing.findMany({ where: { userId: user.id, ebayListingId: { in: ids } }, select: { product: { select: { sku: true } } } });
    asins = rows.map((row) => row.product.sku);
  }
  asins = [...new Set(asins.map((asin) => asin.trim().toUpperCase()).filter((asin) => /^[A-Z0-9]{10}$/.test(asin)))];
  const checkedAt = new Date();
  if (asins.length) await db.$transaction([
    db.adminArbitrageProduct.updateMany({ where: { asin: { in: asins } }, data: { amazonCheckedAt: checkedAt } }),
    db.product.updateMany({ where: { sku: { in: asins }, supplierName: "Amazon" }, data: { amazonCheckedAt: checkedAt } }),
  ]);
  return { checkedAt: checkedAt.toISOString() };
}

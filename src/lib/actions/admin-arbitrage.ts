"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { scanMore } from "@/lib/arbitrage";
import {
  addAmazonCatalogProduct,
  researchAdminCatalogProduct,
} from "@/lib/arbitrage/admin-research";
import { publishCatalogProductToUsers } from "@/lib/arbitrage/admin-catalog";
import type { ScanReport } from "@/lib/arbitrage/scan-types";

export type AdminActionResult = {
  ok: boolean;
  message: string;
};

export type AdminScanResult = AdminActionResult & ScanReport;

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "The operation failed.";
}

export async function adminAddAmazonItem(
  input: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await addAmazonCatalogProduct(input);
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return {
      ok: true,
      message: "Amazon item added and its eBay market research is complete.",
    };
  } catch (error) {
    return { ok: false, message: message(error) };
  }
}

export async function adminResearchItem(id: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await researchAdminCatalogProduct(z.string().min(1).max(100).parse(id));
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return { ok: true, message: "Amazon price, match, and market data refreshed." };
  } catch (error) {
    return { ok: false, message: message(error) };
  }
}

export async function adminPublishItem(id: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await publishCatalogProductToUsers(z.string().min(1).max(100).parse(id));
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return { ok: true, message: "This product is now visible to users." };
  } catch (error) {
    return { ok: false, message: message(error) };
  }
}

export async function adminArchiveItem(id: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    const item = await db.adminArbitrageProduct.findUniqueOrThrow({
      where: { id: z.string().min(1).max(100).parse(id) },
      select: { id: true, ebayItemId: true },
    });
    await db.$transaction([
      db.adminArbitrageProduct.update({
        where: { id: item.id },
        data: { status: "ARCHIVED" },
      }),
      db.arbitrageItem.deleteMany({
        where: { ebayItemId: item.ebayItemId ?? "__none__" },
      }),
    ]);
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return { ok: true, message: "Product archived and removed from user results." };
  } catch (error) {
    return { ok: false, message: message(error) };
  }
}

export async function adminScanBestSellers(
  count: number,
): Promise<AdminScanResult> {
  await requireAdmin();
  const target = z.number().int().min(1).max(100).parse(count);
  try {
    // Keep every request comfortably below the hosting timeout. The admin
    // client resumes these persisted checkpoints until its requested total is
    // reached, the sources are exhausted, or the administrator stops it.
    const report = await scanMore({ target, timeBudgetMs: 22_000 });
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return {
      ...report,
      ok: true,
      message: report.paused
        ? `Research checkpoint saved: ${report.added} products added and ${report.examined} candidates examined. A provider lookup will be retried automatically.`
        : report.exhausted
          ? `Research complete: ${report.added} new products added; the available bestseller sources were exhausted.`
          : `Research checkpoint saved: ${report.added} new products added from ${report.examined} candidates.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: message(error),
      added: 0,
      examined: 0,
      exhausted: false,
      errors: 1,
      paused: true,
    };
  }
}

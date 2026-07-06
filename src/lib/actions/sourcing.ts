"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSupplierProvider } from "@/lib/sourcing";
import { scoreCandidate, suggestPriceCents } from "@/lib/sourcing/scoring";
import { serializeImageUrls } from "@/lib/types";

export type ImportResult = {
  imported: number;
  skipped: number; // already in inventory
  error?: string;
};

/** Import sourcing candidates into the user's product inventory. */
export async function importProducts(
  supplierProductIds: string[],
): Promise<ImportResult> {
  const user = await requireUser();
  if (supplierProductIds.length === 0) {
    return { imported: 0, skipped: 0, error: "Nothing selected" };
  }

  const provider = getSupplierProvider();
  let imported = 0;
  let skipped = 0;

  for (const id of supplierProductIds) {
    const candidate = await provider.getCandidate(id);
    if (!candidate) {
      skipped++;
      continue;
    }
    const existing = await db.product.findUnique({
      where: { userId_sku: { userId: user.id, sku: candidate.supplierProductId } },
    });
    if (existing) {
      skipped++;
      continue;
    }
    const scored = scoreCandidate(candidate);
    await db.product.create({
      data: {
        userId: user.id,
        sku: candidate.supplierProductId,
        title: candidate.title,
        description: candidate.description,
        imageUrlsJson: serializeImageUrls(candidate.imageUrls),
        category: candidate.category,
        supplierName: candidate.supplierName,
        supplierProductId: candidate.supplierProductId,
        supplierUrl: candidate.supplierUrl,
        costCents: candidate.costCents,
        supplierStock: candidate.stock,
        shippingCostCents: candidate.shippingCostCents,
        suggestedPriceCents: suggestPriceCents(candidate),
        sourceScore: scored.score,
      },
    });
    imported++;
  }

  revalidatePath("/sourcing");
  revalidatePath("/listings");
  return { imported, skipped };
}

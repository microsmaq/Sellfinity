"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { refreshAdminBestSellers } from "@/lib/ebay/admin-bestsellers";
import { ebayBestSellerCategory } from "@/lib/ebay/bestseller-categories";

export type BestSellerRefreshState = {
  ok: boolean;
  message: string;
  added?: number;
  totalStored?: number;
  sampled?: number;
  hasMore?: boolean;
} | null;

export async function refreshEbayBestSellers(
  _state: BestSellerRefreshState,
  formData: FormData,
): Promise<BestSellerRefreshState> {
  await requireAdmin();
  const category = ebayBestSellerCategory(String(formData.get("categoryId") ?? "293"));
  const customTerm = String(formData.get("customTerm") ?? "").trim();
  const term = (customTerm || category.searchTerm).slice(0, 120);
  try {
    const snapshot = await refreshAdminBestSellers(term, category.id, category.label);
    revalidatePath("/admin/ebay-bestsellers");
    return {
      ok: true,
      message: snapshot.provider === "EBAY_BROWSE"
        ? `Added ${snapshot.newItemsAdded ?? snapshot.items.length} system-wide new proven seller${snapshot.newItemsAdded === 1 ? "" : "s"}; ${snapshot.totalUniqueStored ?? snapshot.items.length} unique products now stored. Scanned the next eBay result page; 0 Countdown credits.`
        : `Saved ${snapshot.items.length} proven sellers from ${snapshot.sampledListings ?? 0} sampled listings. Countdown used ${snapshot.creditsUsed ?? "the provider-reported number of"} credit${snapshot.creditsUsed === 1 ? "" : "s"}.`,
      added: snapshot.newItemsAdded ?? snapshot.items.length,
      totalStored: snapshot.totalUniqueStored ?? snapshot.items.length,
      sampled: snapshot.lastBatchSampledListings ?? snapshot.sampledListings ?? 0,
      hasMore: snapshot.hasMoreResults ?? false,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message.slice(0, 240) : "The eBay research refresh failed.",
    };
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { refreshAdminBestSellers } from "@/lib/ebay/admin-bestsellers";

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
  const category = String(formData.get("researchTerm") ?? "electronics").trim();
  const customTerm = String(formData.get("customTerm") ?? "").trim();
  const term = (customTerm || category || "electronics").slice(0, 120);
  try {
    const snapshot = await refreshAdminBestSellers(term);
    revalidatePath("/admin/ebay-bestsellers");
    return {
      ok: true,
      message: snapshot.provider === "EBAY_BROWSE"
        ? `Added ${snapshot.newItemsAdded ?? snapshot.items.length} new proven seller${snapshot.newItemsAdded === 1 ? "" : "s"}; ${snapshot.items.length} now stored for this category. Scanned the next eBay result page; 0 Countdown credits.`
        : `Saved ${snapshot.items.length} proven sellers from ${snapshot.sampledListings ?? 0} sampled listings. Countdown used ${snapshot.creditsUsed ?? "the provider-reported number of"} credit${snapshot.creditsUsed === 1 ? "" : "s"}.`,
      added: snapshot.newItemsAdded ?? snapshot.items.length,
      totalStored: snapshot.items.length,
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

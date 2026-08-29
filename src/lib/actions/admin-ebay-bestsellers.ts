"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { refreshAdminBestSellers } from "@/lib/ebay/admin-bestsellers";

export type BestSellerRefreshState = { ok: boolean; message: string } | null;

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
        ? `Saved ${snapshot.items.length} proven sellers from ${snapshot.sampledListings ?? 0} eBay listings. Official eBay fallback used; 0 Countdown credits.`
        : `Saved ${snapshot.items.length} proven sellers from ${snapshot.sampledListings ?? 0} sampled listings. Countdown used ${snapshot.creditsUsed ?? "the provider-reported number of"} credit${snapshot.creditsUsed === 1 ? "" : "s"}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message.slice(0, 240) : "The eBay research refresh failed.",
    };
  }
}

"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncAmazonPurchaseEmails } from "@/lib/amazon-email/sync";
import { importOrders } from "@/lib/orders/import";
import { uploadAmazonTrackingToEbay } from "@/lib/amazon-email/tracking";
import { protectVerifiedOrderMargins } from "@/lib/orders/profit-protection";

export async function syncAmazonEmailsNow() {
  const user = await requireUser();
  try {
    // Ensure there is a current local eBay sale ledger to match against.
    try { await importOrders(user.id); } catch { /* Email ingestion can still proceed. */ }
    const result = await syncAmazonPurchaseEmails(user.id);
    const protection = user.autoProtectVerifiedProfit
      ? await protectVerifiedOrderMargins(user.id)
      : null;
    let tracking = { eligible: 0, uploaded: 0, failed: 0 };
    let trackingError: string | null = null;
    try { tracking = await uploadAmazonTrackingToEbay(user.id); }
    catch (error) { trackingError = error instanceof Error ? error.message.slice(0, 300) : "eBay tracking update failed"; }
    revalidatePath("/dashboard"); revalidatePath("/settings");
    return { ...result, tracking, trackingError, protection };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Amazon email sync failed";
    await db.amazonEmailConnection.updateMany({ where: { userId: user.id }, data: { lastSyncError: message } });
    return { error: message };
  }
}

export async function setAutoUploadTracking(enabled: boolean) {
  const user = await requireUser();
  await db.amazonEmailConnection.update({ where: { userId: user.id }, data: { autoUploadTracking: enabled } });
  revalidatePath("/settings");
  return { enabled };
}

export async function disconnectAmazonEmail() {
  const user = await requireUser();
  await db.amazonEmailConnection.deleteMany({ where: { userId: user.id } });
  revalidatePath("/settings");
}

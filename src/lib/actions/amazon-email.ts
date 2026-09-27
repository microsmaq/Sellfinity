"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncAmazonPurchaseEmails } from "@/lib/amazon-email/sync";
import { importOrders } from "@/lib/orders/import";
import { uploadAmazonTrackingToEbay } from "@/lib/amazon-email/tracking";
import { resolveMissingAmazonTracking } from "@/lib/amazon-email/tracking-resolver";
import { protectVerifiedOrderMargins } from "@/lib/orders/profit-protection";
import { restockLowFulfillmentInventory } from "@/lib/orders/auto-restock";

async function unresolvedTrackingRequests(userId: string) {
  const items = await db.amazonPurchaseItem.findMany({
    where: {
      purchase: { userId, trackingNumber: null, trackingUrl: { not: null } },
      matchedOrder: {
        is: {
          userId,
          ebayTrackingNumber: null,
          status: { not: "REFUNDED" },
          sourcingStatus: { not: "CANCELLED" },
        },
      },
    },
    select: {
      matchedOrderId: true,
      purchase: { select: { trackingUrl: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return items.flatMap((item) =>
    item.matchedOrderId && item.purchase.trackingUrl
      ? [{ orderId: item.matchedOrderId, amazonUrl: item.purchase.trackingUrl }]
      : []
  );
}

export async function syncAmazonEmailsNow() {
  const user = await requireUser();
  try {
    // Ensure there is a current local eBay sale ledger to match against.
    let ebayImport: Awaited<ReturnType<typeof importOrders>> | null = null;
    let ebayImportError: string | null = null;
    try { ebayImport = await importOrders(user.id); }
    catch (error) { ebayImportError = error instanceof Error ? error.message.slice(0, 300) : "eBay order refresh failed"; }
    // Keep the priority phase focused on current orders, email reconciliation,
    // and any tracking number already present in email. Signed-in tracking
    // pages can then start before slower pricing and stock maintenance.
    const result = await syncAmazonPurchaseEmails(user.id, {
      retryTrackingFailures: true,
      maxMessages: 500,
      maxMessageDetails: 75,
      resolveTracking: false,
    });
    let tracking = { eligible: 0, uploaded: 0, savedLocally: 0, failed: 0 };
    let trackingError: string | null = null;
    try { tracking = await uploadAmazonTrackingToEbay(user.id); }
    catch (error) { trackingError = error instanceof Error ? error.message.slice(0, 300) : "eBay tracking update failed"; }
    // Amazon frequently exposes the shipment link in email before its public
    // page reveals a carrier number. Return every still-unresolved link after
    // the email scan so the signed-in Chrome helper can finish the job during
    // this same Refresh run (rather than waiting for a second click).
    const trackingHelperRequests = await unresolvedTrackingRequests(user.id);
    revalidatePath("/dashboard"); revalidatePath("/settings"); revalidatePath("/orders"); revalidatePath("/listings");
    return { ...result, ebayImport, ebayImportError, tracking, trackingError, trackingHelperRequests };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Amazon email sync failed";
    await db.amazonEmailConnection.updateMany({ where: { userId: user.id }, data: { lastSyncError: message } });
    return { error: message };
  }
}

/** Finish non-urgent refresh work after the signed-in Chrome helper has
 * already started resolving tracking pages. Each provider step is isolated so
 * a temporary pricing or stock failure never delays or discards tracking. */
export async function finishFulfillmentMaintenanceNow() {
  const user = await requireUser();
  let trackingResolution = { examined: 0, resolved: 0, pending: 0 };
  let trackingResolutionError: string | null = null;
  try {
    trackingResolution = await resolveMissingAmazonTracking(user.id, { retryFailed: true, maxPurchases: 24 });
  } catch (error) {
    trackingResolutionError = error instanceof Error ? error.message.slice(0, 300) : "Amazon tracking lookup failed";
  }

  let tracking = { eligible: 0, uploaded: 0, savedLocally: 0, failed: 0 };
  let trackingError: string | null = null;
  try { tracking = await uploadAmazonTrackingToEbay(user.id); }
  catch (error) { trackingError = error instanceof Error ? error.message.slice(0, 300) : "eBay tracking update failed"; }

  let protection: Awaited<ReturnType<typeof protectVerifiedOrderMargins>> | null = null;
  let protectionError: string | null = null;
  if (user.autoProtectVerifiedProfit) {
    try { protection = await protectVerifiedOrderMargins(user.id, { maxOrders: 200, retryFailures: true, maxRuntimeMs: 45_000 }); }
    catch (error) { protectionError = error instanceof Error ? error.message.slice(0, 300) : "Profit protection failed"; }
  }

  let restock = { checked: 0, lowStock: 0, restocked: 0, failed: 0 };
  let restockError: string | null = null;
  try { restock = await restockLowFulfillmentInventory(user.id); }
  catch (error) { restockError = error instanceof Error ? error.message.slice(0, 300) : "eBay stock refill failed"; }

  revalidatePath("/dashboard"); revalidatePath("/orders"); revalidatePath("/listings");
  return { trackingResolution, trackingResolutionError, tracking, trackingError, protection, protectionError, restock, restockError };
}

/** Lightweight Settings check: read recent Amazon messages and reconcile
 * purchases already stored in Sellfinity. Fulfillment refresh owns the
 * slower eBay import, tracking-page resolution, repricing, and restocking. */
export async function checkAmazonPurchasesNow() {
  const user = await requireUser();
  try {
    const result = await syncAmazonPurchaseEmails(user.id, {
      maxMessages: 50,
      resolveTracking: false,
    });
    const checkedAt = new Date().toISOString();
    revalidatePath("/dashboard");
    revalidatePath("/orders");
    return { ...result, checkedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Amazon email check failed";
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

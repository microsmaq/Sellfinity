import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncAmazonPurchaseEmails } from "@/lib/amazon-email/sync";
import { importOrders } from "@/lib/orders/import";
import { uploadAmazonTrackingToEbay } from "@/lib/amazon-email/tracking";
import { protectVerifiedOrderMargins } from "@/lib/orders/profit-protection";
import { restockLowFulfillmentInventory } from "@/lib/orders/auto-restock";

export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const connections = await db.amazonEmailConnection.findMany({ where: { status: "CONNECTED" }, select: { userId: true, autoUploadTracking: true, user: { select: { autoProtectVerifiedProfit: true, autoRestockFulfilledListings: true } } }, take: 50 });
  let succeeded = 0; let imported = 0; let matched = 0; let trackingUploaded = 0; let trackingFailed = 0; let restocked = 0; let restockFailed = 0; const failures: string[] = [];
  for (const connection of connections) {
    try {
      try { await importOrders(connection.userId); } catch { /* Keep purchase detection independent of eBay availability. */ }
      const result = await syncAmazonPurchaseEmails(connection.userId); imported += result.imported; matched += result.matched;
      if (connection.user.autoProtectVerifiedProfit) await protectVerifiedOrderMargins(connection.userId);
      if (connection.autoUploadTracking) {
        try { const tracking = await uploadAmazonTrackingToEbay(connection.userId); trackingUploaded += tracking.uploaded; trackingFailed += tracking.failed; }
        catch { trackingFailed++; }
      }
      if (connection.user.autoRestockFulfilledListings) {
        try { const stock = await restockLowFulfillmentInventory(connection.userId); restocked += stock.restocked; restockFailed += stock.failed; }
        catch { restockFailed++; }
      }
      succeeded++;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : "sync failed"; failures.push(connection.userId);
      await db.amazonEmailConnection.update({ where: { userId: connection.userId }, data: { lastSyncError: message } });
    }
  }
  return NextResponse.json({ checked: connections.length, succeeded, imported, matched, trackingUploaded, trackingFailed, restocked, restockFailed, failed: failures.length });
}

import { db } from "@/lib/db";
import { getEbayClient } from "@/lib/ebay";
import type { EbayClient } from "@/lib/ebay/client";
import { getSupplierProvider } from "@/lib/sourcing";
import type { SupplierProvider } from "@/lib/sourcing/provider";
import { planFor } from "@/lib/plans";
import { detectIssues, type DetectedIssue } from "./detect";

export type SyncDeps = {
  provider: SupplierProvider;
  ebay: EbayClient;
};

export type SyncSummary = {
  syncRunId: string;
  listingsChecked: number;
  issuesFound: number;
  issuesAutoFixed: number;
};

/** Apply a fix to a listing: revise eBay, then mirror in our DB. */
export async function applyFix(
  listing: { id: string; ebayListingId: string | null },
  fix: DetectedIssue["fix"],
  ebay: EbayClient,
): Promise<void> {
  switch (fix.kind) {
    case "set_quantity":
      if (listing.ebayListingId)
        await ebay.updateListing(listing.ebayListingId, { quantity: fix.quantity });
      await db.listing.update({
        where: { id: listing.id },
        data: { quantity: fix.quantity },
      });
      break;
    case "set_price":
      if (listing.ebayListingId)
        await ebay.updateListing(listing.ebayListingId, { priceCents: fix.priceCents });
      await db.listing.update({
        where: { id: listing.id },
        data: { priceCents: fix.priceCents },
      });
      break;
    case "end_listing":
      if (listing.ebayListingId) await ebay.endListing(listing.ebayListingId);
      await db.listing.update({
        where: { id: listing.id },
        data: { status: "ENDED", endedAt: new Date() },
      });
      break;
  }
}

/**
 * Check every active listing against current supplier state. Refreshes the
 * product's supplier snapshot, records a SyncRun, files issues, and — on
 * plans with auto-fix — applies the fixes immediately.
 */
export async function runSync(
  user: { id: string; plan: string },
  deps: SyncDeps = { provider: getSupplierProvider(), ebay: getEbayClient() },
): Promise<SyncSummary> {
  const autoFix = planFor(user.plan).autoFix;
  const listings = await db.listing.findMany({
    where: { userId: user.id, status: "ACTIVE" },
    include: { product: true },
  });

  const run = await db.syncRun.create({ data: { userId: user.id } });
  let issuesFound = 0;
  let issuesAutoFixed = 0;

  for (const listing of listings) {
    const state = await deps.provider.getProductState(listing.product.supplierProductId);

    // Refresh the product snapshot so the rest of the app sees current truth.
    await db.product.update({
      where: { id: listing.product.id },
      data: state
        ? { costCents: state.costCents, supplierStock: state.stock }
        : { supplierStock: 0 },
    });

    const detected = detectIssues(
      { priceCents: listing.priceCents, quantity: listing.quantity },
      { shippingCostCents: listing.product.shippingCostCents },
      state,
    );

    const types = new Set(detected.map((d) => d.type));
    // Close prior OPEN issues that no longer apply.
    await db.syncIssue.updateMany({
      where: {
        userId: user.id,
        listingId: listing.id,
        resolution: "OPEN",
        type: { notIn: [...types] },
      },
      data: { resolution: "FIXED", resolvedAt: new Date() },
    });
    // Expire standing ignores whose condition cleared, so a future
    // recurrence of the same issue type gets flagged again.
    await db.syncIssue.deleteMany({
      where: {
        userId: user.id,
        listingId: listing.id,
        resolution: "IGNORED",
        type: { notIn: [...types] },
      },
    });

    for (const issue of detected) {
      // An ignore holds for as long as the condition persists — don't re-nag.
      const ignored = await db.syncIssue.findFirst({
        where: {
          userId: user.id,
          listingId: listing.id,
          type: issue.type,
          resolution: "IGNORED",
        },
      });
      if (ignored) continue;

      issuesFound++;
      let resolution = "OPEN";
      let resolvedAt: Date | null = null;
      if (autoFix && issue.autoFixable) {
        await applyFix(listing, issue.fix, deps.ebay);
        resolution = "AUTO_FIXED";
        resolvedAt = new Date();
        issuesAutoFixed++;
      }
      // Supersede a persisting OPEN issue of the same type with the fresh one.
      await db.syncIssue.deleteMany({
        where: { userId: user.id, listingId: listing.id, type: issue.type, resolution: "OPEN" },
      });
      await db.syncIssue.create({
        data: {
          syncRunId: run.id,
          userId: user.id,
          listingId: listing.id,
          type: issue.type,
          detailsJson: JSON.stringify(issue.details),
          resolution,
          resolvedAt,
        },
      });
    }
  }

  await db.syncRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      listingsChecked: listings.length,
      issuesFound,
      issuesAutoFixed,
    },
  });

  return { syncRunId: run.id, listingsChecked: listings.length, issuesFound, issuesAutoFixed };
}

/** Re-derive and apply the fix for one OPEN issue ("Fix now"). */
export async function fixIssue(
  userId: string,
  issueId: string,
  deps: SyncDeps = { provider: getSupplierProvider(), ebay: getEbayClient() },
): Promise<string | null> {
  const issue = await db.syncIssue.findFirst({
    where: { id: issueId, userId, resolution: "OPEN" },
    include: { listing: { include: { product: true } } },
  });
  if (!issue) return "Issue not found or already resolved";

  const state = await deps.provider.getProductState(issue.listing.product.supplierProductId);
  const detected = detectIssues(
    { priceCents: issue.listing.priceCents, quantity: issue.listing.quantity },
    { shippingCostCents: issue.listing.product.shippingCostCents },
    state,
  );
  const current = detected.find((d) => d.type === issue.type);

  if (current) {
    await applyFix(issue.listing, current.fix, deps.ebay);
  } else {
    // The condition morphed rather than cleared: if the supplier is now gone
    // entirely, ending the listing is the safe fix the user was after.
    const gone = detected.find((d) => d.type === "SUPPLIER_GONE");
    if (gone) await applyFix(issue.listing, gone.fix, deps.ebay);
  }
  // Either we just fixed it, or the condition cleared on its own.
  await db.syncIssue.update({
    where: { id: issue.id },
    data: { resolution: "FIXED", resolvedAt: new Date() },
  });
  return null;
}

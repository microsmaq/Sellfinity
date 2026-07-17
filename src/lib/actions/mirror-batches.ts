"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { mirrorUrl, parseUrlLines } from "@/lib/mirror/pipeline";
import {
  discardFailedMirrorDraft,
  publishListingForUser,
} from "@/lib/listings/publish";
import { sendBatchCompletionEmail } from "@/lib/email/batch-completion";
import {
  AUTO_PUBLISH_MIN_MARGIN_PCT,
  AUTO_PUBLISH_MIN_MATCH_CONFIDENCE,
} from "@/lib/arbitrage/auto-publish";

const MAX_BATCH_ITEMS = 50;
const STALE_PROCESSING_MS = 6 * 60 * 1000;

export type MirrorBatchItemView = {
  id: string;
  position: number;
  inputUrl: string;
  status: string;
  title: string | null;
  sourcePriceCents: number | null;
  listingPriceCents: number | null;
  ebayListingId: string | null;
  error: string | null;
  imageImprovementStatus: string;
  imageImprovementError: string | null;
};

export type MirrorBatchView = {
  id: string;
  source: string;
  trigger: string;
  improveMainImage: boolean;
  status: string;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  emailStatus: string;
  emailSentAt: string | null;
  emailError: string | null;
  items: MirrorBatchItemView[];
};

export type MirrorBatchHistoryRow = Omit<MirrorBatchView, "items">;

function toView(batch: {
  id: string;
  source: string;
  trigger: string;
  improveMainImage: boolean;
  status: string;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  emailStatus: string;
  emailSentAt: Date | null;
  emailError: string | null;
  items: Array<{
    id: string;
    position: number;
    inputUrl: string;
    status: string;
    title: string | null;
    sourcePriceCents: number | null;
    listingPriceCents: number | null;
    ebayListingId: string | null;
    error: string | null;
    imageImprovementStatus: string;
    imageImprovementError: string | null;
  }>;
}): MirrorBatchView {
  return {
    ...batch,
    createdAt: batch.createdAt.toISOString(),
    startedAt: batch.startedAt?.toISOString() ?? null,
    completedAt: batch.completedAt?.toISOString() ?? null,
    emailSentAt: batch.emailSentAt?.toISOString() ?? null,
    items: batch.items,
  };
}

async function loadBatch(userId: string, batchId: string): Promise<MirrorBatchView | null> {
  const batch = await db.mirrorBatch.findFirst({
    where: { id: batchId, userId },
    include: { items: { orderBy: { position: "asc" } } },
  });
  return batch ? toView(batch) : null;
}

async function createBatch(
  userId: string,
  source: "URL_BULK" | "ARBITRAGE",
  items: Array<{ inputUrl: string; sourceReferenceId?: string }>,
  trigger: "MANUAL" | "AUTOMATIC" = "MANUAL",
  improveMainImage = false,
): Promise<{ batchId?: string; error?: string }> {
  const connection = await db.ebayConnection.findUnique({ where: { userId } });
  if (!connection || connection.status === "DISCONNECTED") {
    return { error: "Connect your eBay account in Settings before publishing." };
  }
  if (items.length === 0) return { error: "Select at least one product." };

  const batch = await db.mirrorBatch.create({
    data: {
      userId,
      source,
      trigger,
      improveMainImage,
      totalCount: items.length,
      items: {
        create: items.map((item, position) => ({
          position,
          inputUrl: item.inputUrl,
          sourceReferenceId: item.sourceReferenceId,
          imageImprovementStatus: improveMainImage ? "PENDING" : "NOT_REQUESTED",
        })),
      },
    },
  });
  revalidatePath("/mirror");
  return { batchId: batch.id };
}

export async function createUrlMirrorBatch(
  input: string,
): Promise<{ batchId?: string; error?: string }> {
  const user = await requireUser();
  const urls = parseUrlLines(input, MAX_BATCH_ITEMS);
  if (urls.length === 0) return { error: "Paste at least one Amazon product URL." };
  return createBatch(
    user.id,
    "URL_BULK",
    urls.map((inputUrl) => ({ inputUrl })),
    "MANUAL",
    user.improveMainImage,
  );
}

export async function createArbitrageMirrorBatch(
  ebayItemIds: string[],
): Promise<{ batchId?: string; error?: string }> {
  const user = await requireUser();
  const ids = [...new Set(ebayItemIds)].slice(0, MAX_BATCH_ITEMS);
  const rows = await db.arbitrageItem.findMany({
    where: {
      ebayItemId: { in: ids },
      matchVerdict: { in: ["MATCH", "LIKELY"] },
    },
    select: { ebayItemId: true, amazonUrl: true },
  });
  const byId = new Map(rows.map((row) => [row.ebayItemId, row]));
  const items = ids
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => !!row)
    .map((row) => ({
      inputUrl: row.amazonUrl,
      sourceReferenceId: row.ebayItemId,
    }));
  return createBatch(user.id, "ARBITRAGE", items, "MANUAL", user.improveMainImage);
}

export async function setImproveMainImagePreference(enabled: boolean): Promise<void> {
  const user = await requireUser();
  await db.user.update({
    where: { id: user.id },
    data: { improveMainImage: enabled },
  });
  revalidatePath("/mirror");
  revalidatePath("/arbitrage");
  revalidatePath("/settings");
}

/** Build an automatic batch from every currently available opportunity that
 * clears the documented safety gate. Existing products, hidden rows, and
 * rows already waiting in another batch are excluded. */
export type QualifiedArbitrageBatchResult = {
  batchId?: string;
  eligibleCount: number;
  error?: string;
};

async function createQualifiedArbitrageMirrorBatchForUser(
  userId: string,
): Promise<QualifiedArbitrageBatchResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { autoPublishArbitrage: true, improveMainImage: true },
  });
  if (!user?.autoPublishArbitrage) {
    return { eligibleCount: 0, error: "Automatic publishing is turned off." };
  }

  const [ownedProducts, queuedItems] = await Promise.all([
    db.product.findMany({
      where: { userId },
      select: { sku: true },
    }),
    db.mirrorBatchItem.findMany({
      where: {
        batch: { userId, status: { in: ["PENDING", "RUNNING"] } },
        sourceReferenceId: { not: null },
      },
      select: { sourceReferenceId: true },
    }),
  ]);
  const ownedAsins = [...new Set(ownedProducts.map((product) => product.sku))];
  const queuedEbayIds = [
    ...new Set(
      queuedItems
        .map((item) => item.sourceReferenceId)
        .filter((id): id is string => !!id),
    ),
  ];
  const queuedArbitrageRows = queuedEbayIds.length
    ? await db.arbitrageItem.findMany({
        where: { ebayItemId: { in: queuedEbayIds } },
        select: { asin: true },
      })
    : [];
  const unavailableAsins = [
    ...new Set([
      ...ownedAsins,
      ...queuedArbitrageRows.map((row) => row.asin),
    ]),
  ];
  const rows = await db.arbitrageItem.findMany({
    where: {
      hiddenBy: { none: { userId } },
      matchVerdict: { in: ["MATCH", "LIKELY"] },
      matchConfidence: { gte: AUTO_PUBLISH_MIN_MATCH_CONFIDENCE },
      marginPct: { gte: AUTO_PUBLISH_MIN_MARGIN_PCT },
      profitCents: { gt: 0 },
      ...(unavailableAsins.length > 0 && { asin: { notIn: unavailableAsins } }),
      ...(queuedEbayIds.length > 0 && { ebayItemId: { notIn: queuedEbayIds } }),
    },
    orderBy: [{ profitCents: "desc" }, { matchConfidence: "desc" }],
    select: { ebayItemId: true, asin: true, amazonUrl: true },
  });
  const seenAsins = new Set<string>();
  const uniqueRows = rows.filter((row) => {
    if (seenAsins.has(row.asin)) return false;
    seenAsins.add(row.asin);
    return true;
  });
  if (uniqueRows.length === 0) return { eligibleCount: 0 };

  const result = await createBatch(
    userId,
    "ARBITRAGE",
    uniqueRows.map((row) => ({
      inputUrl: row.amazonUrl,
      sourceReferenceId: row.ebayItemId,
    })),
    "AUTOMATIC",
    user.improveMainImage,
  );
  return { ...result, eligibleCount: uniqueRows.length };
}

export async function createQualifiedArbitrageMirrorBatch(): Promise<QualifiedArbitrageBatchResult> {
  const user = await requireUser();
  return createQualifiedArbitrageMirrorBatchForUser(user.id);
}

export async function getMirrorBatch(batchId: string): Promise<MirrorBatchView | null> {
  const user = await requireUser();
  return loadBatch(user.id, batchId);
}

export async function listMirrorBatchHistory(
  limit = 25,
): Promise<MirrorBatchHistoryRow[]> {
  const user = await requireUser();
  const batches = await db.mirrorBatch.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: Math.min(100, Math.max(1, limit)),
  });
  return batches.map((batch) => ({
    id: batch.id,
    source: batch.source,
    trigger: batch.trigger,
    improveMainImage: batch.improveMainImage,
    status: batch.status,
    totalCount: batch.totalCount,
    succeededCount: batch.succeededCount,
    failedCount: batch.failedCount,
    createdAt: batch.createdAt.toISOString(),
    startedAt: batch.startedAt?.toISOString() ?? null,
    completedAt: batch.completedAt?.toISOString() ?? null,
    emailStatus: batch.emailStatus,
    emailSentAt: batch.emailSentAt?.toISOString() ?? null,
    emailError: batch.emailError,
  }));
}

async function sendCompletionNotification(batchId: string): Promise<void> {
  const claimed = await db.mirrorBatch.updateMany({
    where: { id: batchId, status: "COMPLETED", emailStatus: "PENDING" },
    data: { emailStatus: "SENDING", emailError: null },
  });
  if (claimed.count === 0) return;

  const batch = await db.mirrorBatch.findUnique({
    where: { id: batchId },
    include: { user: { select: { email: true, name: true } } },
  });
  if (!batch) return;

  const activeListingCount = await db.listing.count({
    where: { userId: batch.userId, status: "ACTIVE" },
  });
  const result = await sendBatchCompletionEmail(batch.user.email, {
    name: batch.user.name,
    batchId: batch.id,
    source: batch.source,
    trigger: batch.trigger,
    succeededCount: batch.succeededCount,
    failedCount: batch.failedCount,
    totalCount: batch.totalCount,
    activeListingCount,
    completedAt: batch.completedAt ?? new Date(),
    appUrl: process.env.APP_URL ?? "https://www.sellfinity.app",
  });

  await db.mirrorBatch.update({
    where: { id: batchId },
    data: result.ok
      ? { emailStatus: "SENT", emailSentAt: new Date(), emailError: null }
      : { emailStatus: "FAILED", emailError: result.error.slice(0, 500) },
  });
}

async function completeItem(
  batchId: string,
  itemId: string,
  status: "SUCCEEDED" | "FAILED",
  data: {
    ebayListingId?: string;
    error?: string;
  },
): Promise<void> {
  await db.$transaction([
    db.mirrorBatchItem.update({
      where: { id: itemId },
      data: {
        status,
        ebayListingId: data.ebayListingId,
        error: data.error?.slice(0, 500),
        completedAt: new Date(),
      },
    }),
    db.mirrorBatch.update({
      where: { id: batchId },
      data:
        status === "SUCCEEDED"
          ? { succeededCount: { increment: 1 } }
          : { failedCount: { increment: 1 } },
    }),
  ]);
  const remaining = await db.mirrorBatchItem.count({
    where: { batchId, status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (remaining === 0) {
    await db.mirrorBatch.update({
      where: { id: batchId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await sendCompletionNotification(batchId);
  }
}

/** Advance exactly one item. The live status page calls this repeatedly, so
 * each eBay publish has its own short request and durable result. */
async function processNextMirrorBatchItemForUser(
  userId: string,
  batchId: string,
): Promise<MirrorBatchView | null> {
  const batch = await db.mirrorBatch.findFirst({
    where: { id: batchId, userId },
    select: { id: true, status: true, improveMainImage: true },
  });
  if (!batch) return null;
  if (batch.status === "COMPLETED") {
    await sendCompletionNotification(batchId);
    return loadBatch(userId, batchId);
  }

  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const staleItems = await db.mirrorBatchItem.findMany({
    where: { batchId, status: "PROCESSING", startedAt: { lt: staleBefore } },
    select: { id: true, listingId: true },
  });
  for (const stale of staleItems) {
    const listing = stale.listingId
      ? await db.listing.findFirst({
          where: { id: stale.listingId, userId },
          select: { status: true, ebayListingId: true },
        })
      : null;
    if (listing?.status === "ACTIVE" && listing.ebayListingId) {
      await completeItem(batchId, stale.id, "SUCCEEDED", {
        ebayListingId: listing.ebayListingId,
      });
    } else {
      await db.mirrorBatchItem.update({
        where: { id: stale.id },
        data: { status: "PENDING", startedAt: null },
      });
    }
  }

  const next = await db.mirrorBatchItem.findFirst({
    where: { batchId, status: "PENDING" },
    orderBy: { position: "asc" },
  });
  if (!next) return loadBatch(userId, batchId);
  const claimed = await db.mirrorBatchItem.updateMany({
    where: { id: next.id, status: "PENDING" },
    data: { status: "PROCESSING", startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return loadBatch(userId, batchId);
  await db.mirrorBatch.update({
    where: { id: batchId },
    data: { status: "RUNNING", startedAt: batch.status === "PENDING" ? new Date() : undefined },
  });

  let listingId = next.listingId;
  try {
    if (!listingId) {
      if (batch.improveMainImage) {
        await db.mirrorBatchItem.update({
          where: { id: next.id },
          data: { imageImprovementStatus: "GENERATING", imageImprovementError: null },
        });
      }
      const outcome = await mirrorUrl(userId, next.inputUrl, undefined, {
        sourceMarkupPct: 30,
        improveMainImage: batch.improveMainImage,
      });
      if (!outcome.ok || !outcome.listingId) {
        await completeItem(batchId, next.id, "FAILED", {
          error: outcome.error ?? "Amazon mirroring failed.",
        });
        return loadBatch(userId, batchId);
      }
      listingId = outcome.listingId;
      await db.mirrorBatchItem.update({
        where: { id: next.id },
        data: {
          listingId,
          title: outcome.title,
          sourcePriceCents: outcome.sourcePriceCents,
          listingPriceCents: outcome.priceCents,
          ...(batch.improveMainImage && {
            imageImprovementStatus: outcome.imageImprovementStatus ?? "FALLBACK",
            imageImprovementError: outcome.imageImprovementError?.slice(0, 500),
          }),
        },
      });
    }

    const published = await publishListingForUser(userId, listingId);
    if (published.ok) {
      await completeItem(batchId, next.id, "SUCCEEDED", {
        ebayListingId: published.ebayListingId,
      });
    } else {
      await discardFailedMirrorDraft(userId, listingId);
      await completeItem(batchId, next.id, "FAILED", { error: published.error });
    }
  } catch (error) {
    if (listingId) await discardFailedMirrorDraft(userId, listingId);
    await completeItem(batchId, next.id, "FAILED", {
      error: error instanceof Error ? error.message : "Direct publication failed.",
    });
  }

  revalidatePath("/mirror");
  revalidatePath("/listings");
  revalidatePath("/arbitrage");
  return loadBatch(userId, batchId);
}

export async function processNextMirrorBatchItem(
  batchId: string,
): Promise<MirrorBatchView | null> {
  const user = await requireUser();
  return processNextMirrorBatchItemForUser(user.id, batchId);
}

export type AutomaticBatchProcessingReport = {
  optedInUsers: number;
  batchesCreated: number;
  itemsProcessed: number;
  batchesCompleted: number;
  pendingBatches: number;
};

/** Create/resume one automatic Arbitrage batch per opted-in seller and work
 * it fairly until the cron request approaches its deadline. */
export async function processAutomaticArbitrageBatchesUntil(
  deadlineMs: number,
  cronSecret: string,
): Promise<AutomaticBatchProcessingReport> {
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    throw new Error("Unauthorized automatic batch processor request.");
  }
  const users = await db.user.findMany({
    where: {
      autoPublishArbitrage: true,
      ebayConnection: { is: { status: { not: "DISCONNECTED" } } },
    },
    select: { id: true },
  });
  const batchIds: Array<{ userId: string; batchId: string }> = [];
  let batchesCreated = 0;

  for (const user of users) {
    const existing = await db.mirrorBatch.findFirst({
      where: {
        userId: user.id,
        source: "ARBITRAGE",
        trigger: "AUTOMATIC",
        status: { in: ["PENDING", "RUNNING"] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (existing) {
      batchIds.push({ userId: user.id, batchId: existing.id });
      continue;
    }
    const created = await createQualifiedArbitrageMirrorBatchForUser(user.id);
    if (created.batchId) {
      batchesCreated++;
      batchIds.push({ userId: user.id, batchId: created.batchId });
    }
  }

  let itemsProcessed = 0;
  const completed = new Set<string>();
  while (Date.now() < deadlineMs && completed.size < batchIds.length) {
    let advanced = false;
    for (const batch of batchIds) {
      if (Date.now() >= deadlineMs) break;
      if (completed.has(batch.batchId)) continue;
      const before = await db.mirrorBatch.findUnique({
        where: { id: batch.batchId },
        select: { succeededCount: true, failedCount: true, status: true },
      });
      if (!before || before.status === "COMPLETED") {
        completed.add(batch.batchId);
        continue;
      }
      const next = await processNextMirrorBatchItemForUser(
        batch.userId,
        batch.batchId,
      );
      if (!next || next.status === "COMPLETED") completed.add(batch.batchId);
      const processedBefore = before.succeededCount + before.failedCount;
      const processedAfter = next
        ? next.succeededCount + next.failedCount
        : processedBefore;
      if (processedAfter > processedBefore) {
        itemsProcessed += processedAfter - processedBefore;
        advanced = true;
      }
    }
    if (!advanced) break;
  }

  return {
    optedInUsers: users.length,
    batchesCreated,
    itemsProcessed,
    batchesCompleted: completed.size,
    pendingBatches: batchIds.length - completed.size,
  };
}

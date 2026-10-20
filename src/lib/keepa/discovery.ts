import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { availableKeepaTokens, asObject, automaticKeepaCategories, bestsellerAsins, keepaCatalogData, rootCategories } from "./catalog";
import { requestKeepa } from "./client";

const utcDay = (date: Date) => date.toISOString().slice(0, 10);
const stateRow = () => db.keepaDiscoveryState.upsert({ where: { id: "main" }, create: { id: "main" }, update: {} });
export type KeepaStep = "PROGRESSED" | "WAITING" | "IDLE" | "ERROR" | "UNCONFIGURED";

export async function recordKeepaSchedulerHeartbeat() {
  await db.keepaDiscoveryState.upsert({ where: { id: "main" }, create: { id: "main", lastSchedulerAt: new Date() }, update: { lastSchedulerAt: new Date() } });
  if (!process.env.KEEPA_API_KEY?.trim()) return;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "KeepaDiscoveryState" WHERE "id" = 'main' FOR UPDATE`;
    const state = await tx.keepaDiscoveryState.findUniqueOrThrow({ where: { id: "main" } });
    if (state.initializedAt) return;
    const lists = await tx.keepaBestsellerList.count();
    await tx.keepaDiscoveryState.update({ where: { id: "main" }, data: {
      initializedAt: new Date(), enabled: true, nextRunAt: null,
      autoQueueCategories: lists === 0,
      categoryStatus: state.categoryStatus === "NONE" ? "QUEUED" : state.categoryStatus,
      message: "Automatic import started. Loading physical-product bestseller categories and checking for new ASINs.",
    } });
  });
}

export async function keepaDiscoveryStatus() {
  const [state, lists, counts, recent] = await Promise.all([
    stateRow(),
    db.keepaBestsellerList.findMany({ select: { categoryId: true, name: true, status: true, totalAsins: true, cursor: true, queuedCount: true, existingCount: true, duplicateCount: true, fetchedAt: true, error: true }, orderBy: { createdAt: "asc" } }),
    db.keepaDiscoveryItem.groupBy({ by: ["status"], _count: true }),
    db.keepaDiscoveryItem.findMany({ where: { status: { in: ["IMPORTED", "REVIEW", "MISSING", "UNKNOWN"] } }, orderBy: { updatedAt: "desc" }, take: 15, select: { asin: true, status: true, error: true, updatedAt: true } }),
  ]);
  return { configured: Boolean(process.env.KEEPA_API_KEY?.trim()), enabled: state.enabled,
    dailyTokenBudget: state.dailyTokenBudget, spentToday: state.budgetDay === utcDay(new Date()) ? state.spentTokens : 0,
    totalTokens: state.totalTokens, tokensLeft: availableKeepaTokens(state, new Date()),
    nextRunAt: state.nextRunAt?.toISOString() ?? null, message: state.message, categoryStatus: state.categoryStatus,
    lastSchedulerAt: state.lastSchedulerAt?.toISOString() ?? null,
    schedulerHealthy: Boolean(state.lastSchedulerAt && Date.now() - state.lastSchedulerAt.getTime() < 180000),
    categories: rootCategories({ categories: JSON.parse(state.categoriesJson) }),
    lists: lists.map((list) => ({ ...list, fetchedAt: list.fetchedAt?.toISOString() ?? null })),
    counts: Object.fromEntries(counts.map((row) => [row.status, row._count])),
    recent: recent.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
  };
}

/** A short, resumable unit of work. All callers share one DB lease. */
export async function advanceKeepaDiscovery(): Promise<KeepaStep> {
  await stateRow();
  if (!process.env.KEEPA_API_KEY?.trim()) return "UNCONFIGURED";
  const owner = randomUUID(), now = new Date();
  const acquired = await db.keepaDiscoveryState.updateMany({
    where: { id: "main", enabled: true, OR: [{ lockUntil: null }, { lockUntil: { lt: now } }] },
    data: { lockOwner: owner, lockUntil: new Date(now.getTime() + 180000) },
  });
  if (!acquired.count) return "IDLE";
  try {
    let state = await stateRow();
    // FETCHING means a paid request may have reached Keepa before the previous
    // worker died. Do not silently repeat it, even after a computer restart.
    await db.keepaDiscoveryItem.updateMany({ where: { status: "FETCHING" }, data: { status: "UNKNOWN", error: "Interrupted provider request. Credits may have been used; retry requires confirmation." } });
    await db.keepaBestsellerList.updateMany({ where: { status: "FETCHING" }, data: { status: "UNKNOWN", error: "Interrupted list request. Retry may cost another 50 tokens." } });
    if (state.categoryStatus === "FETCHING") state = await db.keepaDiscoveryState.update({ where: { id: "main" }, data: { categoryStatus: "UNKNOWN", message: "Category lookup was interrupted. Explicitly load categories again to retry." } });
    if (state.autoQueueCategories && state.categoryStatus === "DONE") {
      const categories = automaticKeepaCategories(rootCategories({ categories: JSON.parse(state.categoriesJson) }));
      await db.$transaction(async (tx) => {
        if (categories.length) await tx.keepaBestsellerList.createMany({ data: categories.map((row) => ({ categoryId: row.id, name: row.name })), skipDuplicates: true });
        await tx.keepaDiscoveryState.update({ where: { id: "main" }, data: { autoQueueCategories: false,
          ...(categories.length ? { message: `${categories.length} physical-product categories queued automatically. Saved lists and existing ASINs will be reused or skipped.` } : { enabled: false, message: "Keepa returned no usable root categories. Select a category manually before resuming." }),
        } });
      });
      return "PROGRESSED";
    }

    // Always finish saving already-paid responses, even while the budget waits.
    const saved = await db.keepaDiscoveryItem.findMany({ where: { status: "SAVED" }, orderBy: { createdAt: "asc" }, take: 20 });
    if (saved.length) {
      for (const item of saved) {
        const product = asObject(JSON.parse(item.responseJson ?? "{}"));
        const data = keepaCatalogData(product, item);
        if (!data) {
          await db.keepaDiscoveryItem.update({ where: { asin: item.asin }, data: { status: "REVIEW", error: "Not a usable standard US product. Saved provider details are retained; no automatic retry." } });
          continue;
        }
        await db.$transaction(async (tx) => {
          // The database ASIN constraint also handles a concurrent browser import.
          const created = await tx.adminArbitrageProduct.createMany({ data: [data], skipDuplicates: true });
          await tx.keepaDiscoveryItem.update({ where: { asin: item.asin }, data: { status: created.count ? "IMPORTED" : "SKIPPED", error: null } });
        });
      }
      await db.keepaDiscoveryState.update({ where: { id: "main" }, data: { message: "Saved product details imported. Existing catalog products were not changed." } });
      return "PROGRESSED";
    }

    const pendingCount = await db.keepaDiscoveryItem.count({ where: { status: "PENDING" } });
    const queuedList = await db.keepaBestsellerList.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
    // Prime each newly fetched category immediately; don't spend hours fetching
    // every list before importing anything. After its queued ASINs are drained,
    // rotate to the next category before expanding older cached lists again.
    const list = state.categoryStatus !== "QUEUED" && pendingCount === 0
      ? await db.keepaBestsellerList.findFirst({ where: { status: "SAVED", ...(queuedList ? { cursor: 0 } : {}) }, orderBy: { updatedAt: "asc" } }) : null;
    if (list) {
      const asins = bestsellerAsins(JSON.parse(list.responseJson ?? "{}"));
      // Full list is retained; bounded inserts avoid truncation/serverless limits.
      const chunk = asins.slice(list.cursor, list.cursor + 1000), unique = [...new Set(chunk)];
      await db.$transaction(async (tx) => {
        const existing = await tx.adminArbitrageProduct.findMany({ where: { asin: { in: unique } }, select: { asin: true } });
        const known = new Set(existing.map((row) => row.asin));
        const candidates = unique.filter((asin) => !known.has(asin));
        const queued = candidates.length ? await tx.keepaDiscoveryItem.createMany({ data: candidates.map((asin) => ({
          asin, categoryId: list.categoryId, categoryName: list.name, bestsellerRank: list.cursor + chunk.indexOf(asin) + 1,
        })), skipDuplicates: true }) : { count: 0 };
        const cursor = list.cursor + chunk.length;
        await tx.keepaBestsellerList.update({ where: { categoryId: list.categoryId }, data: {
          cursor, status: cursor >= asins.length ? "DONE" : "SAVED",
          queuedCount: { increment: queued.count }, existingCount: { increment: known.size },
          duplicateCount: { increment: chunk.length - known.size - queued.count },
        } });
      }, { timeout: 30000 });
      await db.keepaDiscoveryState.update({ where: { id: "main" }, data: { message: `Checking saved ${list.name} bestseller ASINs against the catalog. No API credits used for this step.` } });
      return "PROGRESSED";
    }

    if (state.nextRunAt && state.nextRunAt > now) return "WAITING";
    if (state.budgetDay !== utcDay(now)) state = await db.keepaDiscoveryState.update({ where: { id: "main" }, data: { budgetDay: utcDay(now), spentTokens: 0 } });

    const categoriesPending = state.categoryStatus === "QUEUED";
    const nextList = categoriesPending || pendingCount > 0 ? null : queuedList;
    // Also covers lists queued before the category filter was tightened.
    if (nextList && !automaticKeepaCategories([{ id: nextList.categoryId, name: nextList.name }]).length) {
      await db.keepaBestsellerList.update({ where: { categoryId: nextList.categoryId }, data: { status: "EXCLUDED", error: null } });
      await db.keepaDiscoveryState.update({ where: { id: "main" }, data: { message: `Skipped ${nextList.name}: digital products/services are not shippable catalog goods. No API credits used.` } });
      return "PROGRESSED";
    }
    let items = categoriesPending || nextList ? [] : await db.keepaDiscoveryItem.findMany({ where: { status: "PENDING" }, orderBy: [{ createdAt: "asc" }, { asin: "asc" }], take: 20 });
    if (items.length) {
      // Repeat the free lookup immediately before spending any product tokens.
      const existing = await db.adminArbitrageProduct.findMany({ where: { asin: { in: items.map((row) => row.asin) } }, select: { asin: true } });
      if (existing.length) await db.keepaDiscoveryItem.updateMany({ where: { asin: { in: existing.map((row) => row.asin) }, status: "PENDING" }, data: { status: "SKIPPED" } });
      const known = new Set(existing.map((row) => row.asin));
      items = items.filter((row) => !known.has(row.asin));
      if (!items.length) return "PROGRESSED";
    }
    if (!categoriesPending && !nextList && !items.length) {
      await db.keepaDiscoveryState.update({ where: { id: "main" }, data: { enabled: false, message: "Discovery finished. Held or incomplete responses need review; they will not be requested again automatically." } });
      return "IDLE";
    }
    const available = availableKeepaTokens(state, now);
    const budgetLeft = Math.max(0, state.dailyTokenBudget - state.spentTokens);
    if (items.length) items = items.slice(0, Math.min(budgetLeft, available ?? 20));
    const cost = categoriesPending ? 1 : nextList ? 50 : items.length;
    if (budgetLeft < (categoriesPending ? 1 : nextList ? 50 : 1)) {
      const tomorrow = new Date(now); tomorrow.setUTCHours(24, 0, 0, 0);
      await db.keepaDiscoveryState.update({ where: { id: "main" }, data: { nextRunAt: tomorrow, message: "Daily token budget reached. Waiting until midnight UTC; saved results are safe." } });
      return "WAITING";
    }
    if (!cost || (available !== null && available < cost)) {
      const needed = categoriesPending ? 1 : nextList ? 50 : 1;
      const minutes = Math.max(1, Math.ceil((needed - (available ?? 0)) / Math.max(1, Math.min(20, state.refillRate))));
      await db.keepaDiscoveryState.update({ where: { id: "main" }, data: { nextRunAt: new Date(now.getTime() + minutes * 60000), message: "Waiting for Keepa tokens to refill. No repeated requests while waiting." } });
      return "WAITING";
    }

    // Reserve worst-case cost *before* the network request. Unknown outcomes keep
    // this reservation so crashes cannot erase the daily spending record.
    const reserved = await db.$transaction(async (tx) => {
      const claim = await tx.keepaDiscoveryState.updateMany({
        where: { id: "main", enabled: true, lockOwner: owner, lockUntil: { gt: new Date() },
          budgetDay: state.budgetDay, spentTokens: state.spentTokens, dailyTokenBudget: { gte: state.spentTokens + cost } },
        data: { spentTokens: { increment: cost }, totalTokens: { increment: cost }, tokensLeft: available === null ? null : Math.max(0, available - cost), tokenSampleAt: now, nextRunAt: null, ...(categoriesPending ? { categoryStatus: "FETCHING" } : {}) },
      });
      if (!claim.count) return false;
      if (nextList) await tx.keepaBestsellerList.update({ where: { categoryId: nextList.categoryId }, data: { status: "FETCHING", attemptedAt: now } });
      if (items.length) await tx.keepaDiscoveryItem.updateMany({ where: { asin: { in: items.map((row) => row.asin) } }, data: { status: "FETCHING", attemptedAt: now } });
      return true;
    });
    if (!reserved) return "IDLE";
    const result = await requestKeepa(categoriesPending ? "category" : nextList ? "bestsellers" : "product",
      categoriesPending ? { category: "0", parents: "0" } : nextList ? { category: nextList.categoryId, range: "0", variations: "0" } : {
        asin: items.map((row) => row.asin).join(","), stats: "90", days: "90", history: "1", update: "1", aplus: "1", videos: "1",
      });
    const receivedAt = new Date(), body = result.body;
    const success = result.status >= 200 && result.status < 300 && !body.error;
    const limited = result.status === 429;
    const temporary = result.status >= 500;
    const consumed = typeof body.tokensConsumed === "number" && Number.isInteger(body.tokensConsumed) && body.tokensConsumed >= 0 ? body.tokensConsumed : limited ? 0 : cost;
    // Paid response and accounting are saved atomically before parsing/importing.
    await db.$transaction(async (tx) => {
      // Fence expired workers before they can overwrite a newer worker's state.
      await tx.$queryRaw`SELECT "id" FROM "KeepaDiscoveryState" WHERE "id" = 'main' FOR UPDATE`;
      const currentLease = await tx.keepaDiscoveryState.findUniqueOrThrow({ where: { id: "main" } });
      if (currentLease.lockOwner !== owner) throw new Error("Discovery lease expired.");
      await tx.keepaDiscoveryState.update({ where: { id: "main" }, data: {
        spentTokens: { increment: consumed - cost }, totalTokens: { increment: consumed - cost },
        ...(typeof body.tokensLeft === "number" ? { tokensLeft: Math.floor(body.tokensLeft) } : {}),
        tokenSampleAt: receivedAt,
        refillRate: typeof body.refillRate === "number" ? Math.max(0, Math.min(20, Math.floor(body.refillRate))) : state.refillRate,
        nextRunAt: limited ? new Date(receivedAt.getTime() + Math.max(60000, typeof body.refillIn === "number" ? body.refillIn : 60000)) : temporary ? new Date(receivedAt.getTime() + 300000) : null,
        message: limited ? "Keepa token balance is low. The queue will resume after refill." : success ? "Provider response saved locally. Importing does not use more tokens." : temporary ? "Keepa is temporarily unavailable. Uncertain requests are held; other new ASINs will continue after a five-minute wait." : `Keepa returned HTTP ${result.status}. No automatic retry; review before spending again.`,
        ...(!success && !limited && !temporary ? { enabled: false } : {}),
        ...(categoriesPending ? { categoryStatus: success ? "DONE" : limited ? "QUEUED" : "UNKNOWN", ...(success ? { categoriesJson: JSON.stringify(rootCategories(body).map((row) => ({ catId: row.id, name: row.name }))) } : {}) } : {}),
      } });
      if (nextList) await tx.keepaBestsellerList.update({ where: { categoryId: nextList.categoryId }, data: success ? {
        status: "SAVED", responseJson: JSON.stringify(body), totalAsins: bestsellerAsins(body).length, fetchedAt: receivedAt, error: null,
      } : { status: limited ? "QUEUED" : "UNKNOWN", error: limited ? null : `Keepa HTTP ${result.status}; review before retry.` } });
      if (items.length) {
        const products = Array.isArray(body.products) ? body.products.map(asObject) : [];
        for (const item of items) {
          const product = products.find((row) => row.asin === item.asin);
          await tx.keepaDiscoveryItem.update({ where: { asin: item.asin }, data: success ? {
            status: product ? "SAVED" : "MISSING", responseJson: JSON.stringify(product ?? { asin: item.asin, missing: true, tokensConsumed: body.tokensConsumed, timestamp: body.timestamp }), fetchedAt: receivedAt,
            error: product ? null : "Keepa returned no product. Not retried automatically.",
          } : { status: limited ? "PENDING" : "UNKNOWN", error: limited ? null : `Keepa HTTP ${result.status}; review before retry.` } });
        }
      }
    }, { timeout: 30000 });
    return success ? "PROGRESSED" : limited || temporary ? "WAITING" : "ERROR";
  } catch {
    // Never return/log provider URLs: they contain the private API key.
    await db.keepaDiscoveryState.updateMany({ where: { id: "main", lockOwner: owner }, data: { nextRunAt: new Date(Date.now() + 300000), message: "Temporary request or save interruption. Saved results are retained; uncertain requests are held without retrying. Other new ASINs will continue after five minutes." } });
    return "WAITING";
  } finally {
    await db.keepaDiscoveryState.updateMany({ where: { id: "main", lockOwner: owner }, data: { lockOwner: null, lockUntil: null } });
  }
}

"use server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { advanceKeepaDiscovery, keepaDiscoveryStatus } from "@/lib/keepa/discovery";
import { getKeepaImportSummary } from "@/lib/keepa/reporting";

const ensureState = () => db.keepaDiscoveryState.upsert({ where: { id: "main" }, create: { id: "main" }, update: {} });
async function requireIdle() {
  const state = await ensureState();
  if (state.lockUntil && state.lockUntil > new Date()) throw new Error("An import step is finishing. Try again in a moment.");
  return state;
}
export async function getKeepaDiscoveryStatus() {
  await requireAdmin();
  return keepaDiscoveryStatus();
}
export async function getKeepaDashboardSummary() {
  await requireAdmin();
  return getKeepaImportSummary();
}
export async function runKeepaDiscoveryStep() {
  await requireAdmin();
  await advanceKeepaDiscovery();
  return keepaDiscoveryStatus();
}
export async function configureKeepaDiscovery(raw: unknown) {
  await requireAdmin();
  const input = z.object({ enabled: z.boolean(), dailyTokenBudget: z.number().int().min(50).max(28800) }).parse(raw);
  if (input.enabled && !process.env.KEEPA_API_KEY?.trim()) throw new Error("Ask your administrator to configure KEEPA_API_KEY on the server first.");
  const state = await ensureState();
  await db.keepaDiscoveryState.update({ where: { id: "main" }, data: { ...input, initializedAt: new Date(), ...(input.enabled && state.autoQueueCategories && state.categoryStatus === "NONE" ? { categoryStatus: "QUEUED" } : {}), nextRunAt: null, message: input.enabled ? "Discovery resumed from saved progress." : "Paused. Any current request will finish saving; no new requests will start." } });
  return keepaDiscoveryStatus();
}
export async function queueKeepaCategories(refresh = false) {
  await requireAdmin();
  refresh = z.boolean().parse(refresh);
  const state = await requireIdle();
  if (!process.env.KEEPA_API_KEY?.trim()) throw new Error("Configure KEEPA_API_KEY on the server first.");
  if (state.categoryStatus === "DONE" && !refresh) return keepaDiscoveryStatus();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "KeepaDiscoveryState" WHERE "id" = 'main' FOR UPDATE`;
    const current = await tx.keepaDiscoveryState.findUniqueOrThrow({ where: { id: "main" } });
    if (current.lockUntil && current.lockUntil > new Date()) throw new Error("An import step is finishing.");
    await tx.keepaDiscoveryState.update({ where: { id: "main" }, data: { enabled: true, initializedAt: new Date(), autoQueueCategories: false, categoryStatus: "QUEUED", nextRunAt: null } });
  });
  return keepaDiscoveryStatus();
}
export async function queueKeepaBestsellers(raw: unknown, refresh = false) {
  await requireAdmin();
  refresh = z.boolean().parse(refresh);
  const categories = z.array(z.object({ id: z.string().regex(/^\d{1,18}$/), name: z.string().trim().min(1).max(200) })).min(1).max(200).parse(raw);
  await requireIdle();
  if (!process.env.KEEPA_API_KEY?.trim()) throw new Error("Configure KEEPA_API_KEY on the server first.");
  // Serialize configuration with the same lease as the paid worker. Reread locks
  // in the transaction, using a row lock rather than a time-of-check-only guard.
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "KeepaDiscoveryState" WHERE "id" = 'main' FOR UPDATE`;
    const state = await tx.keepaDiscoveryState.findUniqueOrThrow({ where: { id: "main" } });
    if (state.lockUntil && state.lockUntil > new Date()) throw new Error("An import step is finishing. Try again shortly.");
    for (const category of [...new Map(categories.map((row) => [row.id, row])).values()]) {
      const existing = await tx.keepaBestsellerList.findUnique({ where: { categoryId: category.id } });
      if (!existing) await tx.keepaBestsellerList.create({ data: { categoryId: category.id, name: category.name } });
      else if (refresh) {
        if (!["DONE", "ERROR", "UNKNOWN"].includes(existing.status)) throw new Error("Finish or resume the existing saved list before fetching it again.");
        await tx.keepaBestsellerList.update({ where: { categoryId: category.id }, data: { name: category.name, status: "QUEUED", responseJson: null, cursor: 0, totalAsins: 0, queuedCount: 0, existingCount: 0, duplicateCount: 0, error: null, fetchedAt: null } });
      }
    }
    await tx.keepaDiscoveryState.update({ where: { id: "main" }, data: { enabled: true, initializedAt: new Date(), autoQueueCategories: false, nextRunAt: null, message: "Bestseller discovery queued. Existing saved lists are reused unless a paid refresh was requested." } });
  }, { timeout: 30000 });
  return keepaDiscoveryStatus();
}
export async function retryUncertainKeepaRequests(confirmed: boolean) {
  await requireAdmin();
  if (confirmed !== true) throw new Error("Confirm possible duplicate charges before retrying.");
  if (!process.env.KEEPA_API_KEY?.trim()) throw new Error("Configure KEEPA_API_KEY on the server first.");
  await requireIdle();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "KeepaDiscoveryState" WHERE "id" = 'main' FOR UPDATE`;
    const state = await tx.keepaDiscoveryState.findUniqueOrThrow({ where: { id: "main" } });
    if (state.lockUntil && state.lockUntil > new Date()) throw new Error("An import step is finishing.");
    await tx.keepaDiscoveryItem.updateMany({ where: { status: { in: ["UNKNOWN", "FETCHING"] } }, data: { status: "PENDING", error: null } });
    await tx.keepaBestsellerList.updateMany({ where: { status: { in: ["UNKNOWN", "FETCHING"] } }, data: { status: "QUEUED", error: null } });
    await tx.keepaDiscoveryState.update({ where: { id: "main" }, data: { enabled: true, initializedAt: new Date(), nextRunAt: null, ...(["UNKNOWN", "FETCHING"].includes(state.categoryStatus) ? { categoryStatus: "QUEUED" } : {}), message: "Uncertain requests queued again with administrator confirmation." } });
  });
  return keepaDiscoveryStatus();
}
export async function getSavedKeepaProduct(rawAsin: string) {
  await requireAdmin();
  const asin = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/).parse(rawAsin);
  const item = await db.keepaDiscoveryItem.findUnique({ where: { asin }, select: { responseJson: true } });
  if (!item?.responseJson) throw new Error("There is no saved Keepa product response for this ASIN.");
  return item.responseJson;
}

import "server-only";
import { db } from "@/lib/db";
import {
  fetchCountdownBestSellers,
  type CountdownBestSeller,
  type CountdownBestSellerSnapshot,
} from "./countdown";
import { fetchEbayBrowseBestSellers } from "./browse-bestsellers";

const CACHE_PREFIX = "countdown:ebay-bestsellers:";

export type BestSellerSort =
  | "sales"
  | "price"
  | "title"
  | "seller"
  | "position";

export type BestSellerPage = {
  snapshot: CountdownBestSellerSnapshot | null;
  availableDates: { key: string; label: string; capturedAt: string; researchTerm: string }[];
  rows: CountdownBestSeller[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  totalReportedSales: number;
  averagePriceCents: number;
};

function cacheKey(snapshot: CountdownBestSellerSnapshot): string {
  return cacheKeyFor(snapshot.researchTerm, snapshot.capturedAt.slice(0, 10));
}

function cacheKeyFor(researchTerm: string, day: string): string {
  const scope = researchTerm
    ? researchTerm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "search"
    : "all";
  return `${CACHE_PREFIX}${day}:${scope}`;
}

function parseSnapshot(dataJson: string): CountdownBestSellerSnapshot | null {
  try {
    const value = JSON.parse(dataJson) as CountdownBestSellerSnapshot;
    return value && Array.isArray(value.items) && typeof value.capturedAt === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function refreshAdminBestSellers(researchTerm = "") {
  const term = researchTerm.trim().slice(0, 120) || "electronics";
  const todayKey = cacheKeyFor(term, new Date().toISOString().slice(0, 10));
  const existingCache = await db.scanCache.findUnique({
    where: { cacheKey: todayKey },
    select: { dataJson: true },
  });
  const existing = existingCache ? parseSnapshot(existingCache.dataJson) : null;
  const previousOffset = existing?.provider === "EBAY_BROWSE"
    ? Math.max(0, Number(existing.searchOffset ?? 0))
    : 0;
  const previousPageSize = existing?.provider === "EBAY_BROWSE"
    ? Math.max(1, Number(existing.requestedResults ?? 0) || 100)
    : 0;
  const resultCap = Math.min(10_000, Math.max(0, Number(existing?.totalResults ?? 0)));
  const proposedOffset = previousOffset + previousPageSize;
  const nextOffset = resultCap > 0 && proposedOffset >= resultCap ? 0 : proposedOffset;
  let snapshot: CountdownBestSellerSnapshot;
  if (existing?.provider === "EBAY_BROWSE") {
    snapshot = await fetchEbayBrowseBestSellers(term, nextOffset);
  } else {
    try {
      snapshot = await fetchCountdownBestSellers(term);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/\b50[234]\b|currently unavailable|could not return/i.test(message)) throw error;
      snapshot = await fetchEbayBrowseBestSellers(term, nextOffset);
    }
  }

  const lastBatchSampledListings = Number(snapshot.lastBatchSampledListings ?? snapshot.sampledListings ?? 0);
  const priorItems = existing?.items ?? [];
  const priorIds = new Set(priorItems.map((item) => item.itemId));
  const newItemsAdded = snapshot.items.reduce(
    (count, item) => count + (priorIds.has(item.itemId) ? 0 : 1),
    0,
  );
  if (existing) {
    const merged = new Map(priorItems.map((item) => [item.itemId, item]));
    for (const item of snapshot.items) merged.set(item.itemId, item);
    snapshot = {
      ...snapshot,
      items: [...merged.values()].sort(
        (a, b) => b.quantitySold - a.quantitySold || a.sourcePosition - b.sourcePosition,
      ),
      sampledListings: Number(existing.sampledListings ?? 0) + Number(snapshot.sampledListings ?? 0),
      newItemsAdded,
      lastBatchSampledListings,
    };
  } else {
    snapshot.newItemsAdded = snapshot.items.length;
    snapshot.lastBatchSampledListings = lastBatchSampledListings;
  }
  await db.scanCache.upsert({
    where: { cacheKey: cacheKey(snapshot) },
    create: { cacheKey: cacheKey(snapshot), dataJson: JSON.stringify(snapshot) },
    update: { dataJson: JSON.stringify(snapshot) },
  });
  return snapshot;
}

export async function listAdminBestSellers(options: {
  snapshotKey?: string;
  query?: string;
  sort?: BestSellerSort;
  descending?: boolean;
  page?: number;
  pageSize?: number;
}): Promise<BestSellerPage> {
  const caches = await db.scanCache.findMany({
    where: { cacheKey: { startsWith: CACHE_PREFIX } },
    orderBy: { updatedAt: "desc" },
    take: 90,
    select: { cacheKey: true, dataJson: true },
  });
  const parsed = caches.flatMap((cache) => {
    const snapshot = parseSnapshot(cache.dataJson);
    return snapshot ? [{ key: cache.cacheKey, snapshot }] : [];
  });
  const selected = options.snapshotKey
    ? parsed.find((entry) => entry.key === options.snapshotKey) ?? parsed[0]
    : parsed[0];
  const snapshot = selected?.snapshot ?? null;
  const query = options.query?.trim().toLowerCase() ?? "";
  const sort = options.sort ?? "sales";
  const direction = options.descending === false ? 1 : -1;
  // Enforce the proven-demand rule while reading too, so snapshots created by
  // older releases immediately stop showing unknown/zero-sales rows.
  const proven = (snapshot?.items ?? []).filter((item) => Number(item.quantitySold) > 0);
  const filtered = proven.filter((item) => !query ||
    `${item.title} ${item.itemId} ${item.sellerName} ${item.condition}`.toLowerCase().includes(query));
  filtered.sort((a, b) => {
    let compared = 0;
    if (sort === "price") compared = a.totalPriceCents - b.totalPriceCents;
    else if (sort === "title") compared = a.title.localeCompare(b.title);
    else if (sort === "seller") compared = a.sellerName.localeCompare(b.sellerName);
    else if (sort === "position") compared = a.sourcePosition - b.sourcePosition;
    else compared = a.quantitySold - b.quantitySold;
    return compared * direction || a.sourcePosition - b.sourcePosition;
  });
  const pageSize = [25, 50, 100].includes(options.pageSize ?? 0) ? options.pageSize! : 50;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, options.page ?? 1));
  const totalReportedSales = filtered.reduce((sum, item) => sum + item.quantitySold, 0);
  const averagePriceCents = filtered.length
    ? Math.round(filtered.reduce((sum, item) => sum + item.totalPriceCents, 0) / filtered.length)
    : 0;
  return {
    snapshot,
    availableDates: parsed.map(({ key, snapshot: item }) => ({
      key,
      capturedAt: item.capturedAt,
      researchTerm: item.researchTerm,
      label: `${item.capturedAt.slice(0, 10)} · ${item.researchTerm || "All eBay"}`,
    })),
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    totalRows: filtered.length,
    totalPages,
    totalReportedSales,
    averagePriceCents,
  };
}

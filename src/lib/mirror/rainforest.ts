// Real Amazon product data via the Rainforest API (rainforestapi.com).
// Selected automatically when RAINFOREST_API_KEY is set. Each scrape costs
// one API credit.

import type { ProductPageScraper, ScrapedProduct } from "./scraper";
import { extractAsin } from "./scraper";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const API_BASE = "https://api.rainforestapi.com/request";
const ACCOUNT_API = "https://api.rainforestapi.com/account";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LEASE_MS = 25_000;
const inFlight = new Map<string, Promise<unknown>>();

export type RainforestRequestOptions = {
  workflow?: string;
  ttlMs?: number;
  forceFresh?: boolean;
  bypassDailyBudget?: boolean;
};

export type RainforestAccountUsage = {
  creditsUsed: number;
  creditsLimit: number;
  creditsRemaining: number;
  creditsResetAt: string | null;
};

let accountMemo: { value: RainforestAccountUsage | null; expiresAt: number } | null = null;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function requestCacheKey(params: Record<string, string>): string {
  const normalized = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value.trim().toLowerCase()}`)
    .join("&");
  return createHash("sha256").update(`amazon.com&${normalized}`).digest("hex");
}

function defaultTtlMs(params: Record<string, string>): number {
  if (params.type === "search") return DAY;
  if (params.variant_prices === "true") return 4 * HOUR;
  return 2 * HOUR;
}

function cacheEnabled(): boolean {
  return process.env.NODE_ENV !== "test" && process.env.RAINFOREST_CACHE_DISABLED !== "1";
}

async function recordUsage(
  workflow: string,
  requestType: string,
  field: "providerRequests" | "cacheHits" | "failures" | "budgetBlocks",
): Promise<void> {
  if (!cacheEnabled()) return;
  try {
    await db.rainforestUsageDaily.upsert({
      where: {
        day_workflow_requestType: {
          day: todayUtc(),
          workflow,
          requestType,
        },
      },
      create: {
        day: todayUtc(),
        workflow,
        requestType,
        [field]: 1,
      },
      update: { [field]: { increment: 1 } },
    });
  } catch {
    // Usage accounting must never turn a successful provider request into a
    // failed customer operation.
  }
}

export async function getRainforestAccountUsage(): Promise<RainforestAccountUsage | null> {
  if (!process.env.RAINFOREST_API_KEY) return null;
  if (accountMemo && accountMemo.expiresAt > Date.now()) return accountMemo.value;
  try {
    const query = new URLSearchParams({ api_key: process.env.RAINFOREST_API_KEY });
    const response = await fetch(`${ACCOUNT_API}?${query}`, {
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      account_info?: {
        credits_used?: number;
        credits_limit?: number;
        credits_remaining?: number;
        credits_reset_at?: string;
      };
    };
    const info = body.account_info;
    const value = info && typeof info.credits_remaining === "number"
      ? {
          creditsUsed: info.credits_used ?? 0,
          creditsLimit: info.credits_limit ?? 0,
          creditsRemaining: info.credits_remaining,
          creditsResetAt: info.credits_reset_at ?? null,
        }
      : null;
    accountMemo = { value, expiresAt: Date.now() + 15 * 60 * 1000 };
    return value;
  } catch {
    accountMemo = { value: null, expiresAt: Date.now() + 5 * 60 * 1000 };
    return null;
  }
}

async function enforceBudget(
  workflow: string,
  requestType: string,
  bypass: boolean,
): Promise<void> {
  if (!cacheEnabled() || bypass) return;
  const account = await getRainforestAccountUsage();
  // Use all available credits by default. Operators can still configure a
  // reserve explicitly, while the separate daily budget prevents runaway use.
  const reserve = Math.max(0, Number(process.env.RAINFOREST_MIN_CREDIT_RESERVE ?? 0));
  if (account && account.creditsRemaining <= reserve) {
    await recordUsage(workflow, requestType, "budgetBlocks");
    throw new Error(`Rainforest credit reserve reached (${account.creditsRemaining} remaining).`);
  }
  const dailyBudget = rainforestDailyBudget(account);
  if (!dailyBudget) return;
  const aggregate = await db.rainforestUsageDaily.aggregate({
    where: { day: todayUtc() },
    _sum: { providerRequests: true },
  });
  if ((aggregate._sum.providerRequests ?? 0) >= dailyBudget) {
    await recordUsage(workflow, requestType, "budgetBlocks");
    throw new Error(`Rainforest daily credit budget reached (${dailyBudget}).`);
  }
}

function rainforestDailyBudget(
  account: RainforestAccountUsage | null,
): number | null {
  const configured = Number(process.env.RAINFOREST_DAILY_CREDIT_BUDGET ?? "");
  return Number.isFinite(configured) && configured > 0
    ? configured
    : account?.creditsLimit
      ? Math.max(1, Math.floor((account.creditsLimit / 30) * 0.9))
      : null;
}

export async function getRainforestEfficiencySummary() {
  const rows = cacheEnabled()
    ? await db.rainforestUsageDaily.findMany({ where: { day: todayUtc() } })
    : [];
  const totals = rows.reduce(
    (sum, row) => ({
      providerRequests: sum.providerRequests + row.providerRequests,
      cacheHits: sum.cacheHits + row.cacheHits,
      failures: sum.failures + row.failures,
      budgetBlocks: sum.budgetBlocks + row.budgetBlocks,
    }),
    { providerRequests: 0, cacheHits: 0, failures: 0, budgetBlocks: 0 },
  );
  const account = await getRainforestAccountUsage();
  return {
    day: todayUtc(),
    ...totals,
    account,
    dailyBudget: rainforestDailyBudget(account),
    minimumReserve: Math.max(
      0,
      Number(process.env.RAINFOREST_MIN_CREDIT_RESERVE ?? 0),
    ),
  };
}

/** The slice of Rainforest's type=product response we consume. */
export type RainforestProduct = {
  title?: string;
  brand?: string;
  description?: string;
  feature_bullets?: string[];
  main_image?: { link?: string };
  images?: { link?: string }[];
  categories?: { name?: string }[];
  buybox_winner?: {
    price?: { value?: number };
    availability?: { type?: string };
  };
};

/** Pure mapping from a Rainforest product payload to our scraper shape. */
export function mapRainforestProduct(
  asin: string,
  product: RainforestProduct,
): ScrapedProduct | null {
  const priceValue = product.buybox_winner?.price?.value;
  if (!product.title || typeof priceValue !== "number" || priceValue <= 0) {
    return null; // unbuyable/incomplete page — not mirrorable
  }
  const images = [
    product.main_image?.link,
    ...(product.images ?? []).map((i) => i.link),
  ].filter((u): u is string => typeof u === "string");

  return {
    sourceId: asin,
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    title: product.title,
    brand: product.brand ?? "Unbranded",
    bulletPoints: (product.feature_bullets ?? []).slice(0, 8),
    description:
      product.description ??
      (product.feature_bullets ?? []).join(". ").slice(0, 2000),
    category: product.categories?.[0]?.name ?? "Other",
    imageUrls: [...new Set(images)].slice(0, 12),
    priceCents: Math.round(priceValue * 100),
    inStock: product.buybox_winner?.availability?.type !== "out_of_stock",
  };
}

/** One Rainforest GET; returns the parsed body or throws on HTTP failure. */
export async function rainforestRequest<T>(
  params: Record<string, string>,
  options: RainforestRequestOptions = {},
): Promise<T> {
  const key = process.env.RAINFOREST_API_KEY;
  if (!key) throw new Error("RAINFOREST_API_KEY is not set");
  const workflow = options.workflow ?? "unspecified";
  const requestType = params.type ?? "unknown";
  const cacheKey = requestCacheKey(params);
  const existingPromise = inFlight.get(cacheKey);
  if (existingPromise) {
    await recordUsage(workflow, requestType, "cacheHits");
    return existingPromise as Promise<T>;
  }

  const request = (async (): Promise<T> => {
    const now = new Date();
    if (cacheEnabled() && !options.forceFresh) {
      const cached = await db.rainforestCache.findUnique({ where: { cacheKey } });
      if (cached?.responseJson && cached.expiresAt > now) {
        await recordUsage(workflow, requestType, "cacheHits");
        return JSON.parse(cached.responseJson) as T;
      }
    }

    let leaseClaimed = !cacheEnabled();
    if (cacheEnabled()) {
      try {
        await db.rainforestCache.create({
          data: {
            cacheKey,
            requestType,
            expiresAt: new Date(0),
            lockedUntil: new Date(Date.now() + LEASE_MS),
          },
        });
        leaseClaimed = true;
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
          throw error;
        }
        const claimed = await db.rainforestCache.updateMany({
          where: {
            cacheKey,
            ...(!options.forceFresh && { expiresAt: { lte: now } }),
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
          },
          data: { lockedUntil: new Date(Date.now() + LEASE_MS), requestType },
        });
        leaseClaimed = claimed.count === 1;
      }
      if (!leaseClaimed) {
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const completed = await db.rainforestCache.findUnique({ where: { cacheKey } });
          if (completed?.responseJson && completed.expiresAt > new Date()) {
            await recordUsage(workflow, requestType, "cacheHits");
            return JSON.parse(completed.responseJson) as T;
          }
        }
        throw new Error("An identical Rainforest lookup is already in progress; retry shortly.");
      }
    }

    try {
      await enforceBudget(workflow, requestType, options.bypassDailyBudget === true);
      const query = new URLSearchParams({
        api_key: key,
        amazon_domain: "amazon.com",
        ...params,
      });
      await recordUsage(workflow, requestType, "providerRequests");
      const res = await fetch(`${API_BASE}?${query}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        throw new Error(`Rainforest ${requestType} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      }
      const body = (await res.json()) as T;
      const providerReportedFailure =
        typeof body === "object" &&
        body !== null &&
        "request_info" in body &&
        (body as { request_info?: { success?: boolean } }).request_info?.success === false;
      if (providerReportedFailure) {
        await recordUsage(workflow, requestType, "failures");
        if (cacheEnabled()) {
          await db.rainforestCache.updateMany({
            where: { cacheKey },
            data: { responseJson: null, expiresAt: new Date(0), lockedUntil: null },
          });
        }
        return body;
      }
      if (cacheEnabled()) {
        await db.rainforestCache.update({
          where: { cacheKey },
          data: {
            responseJson: JSON.stringify(body),
            expiresAt: new Date(Date.now() + (options.ttlMs ?? defaultTtlMs(params))),
            lockedUntil: null,
          },
        });
      }
      return body;
    } catch (error) {
      await recordUsage(workflow, requestType, "failures");
      if (cacheEnabled() && leaseClaimed) {
        await db.rainforestCache.updateMany({
          where: { cacheKey },
          data: { lockedUntil: null, expiresAt: new Date(0) },
        });
      }
      throw error;
    }
  })();
  inFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    inFlight.delete(cacheKey);
  }
}

export class RainforestScraper implements ProductPageScraper {
  async scrape(url: string): Promise<ScrapedProduct | null> {
    const asin = extractAsin(url);
    if (!asin) return null;
    const data = await rainforestRequest<{
      request_info?: { success?: boolean };
      product?: RainforestProduct;
    }>({ type: "product", asin }, { workflow: "mirror_or_inventory" });
    if (!data.request_info?.success || !data.product) return null;
    return mapRainforestProduct(asin, data.product);
  }
}

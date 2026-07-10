// Integration tests for the persistent arbitrage research database.

import { execSync } from "node:child_process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { scanMore } from "@/lib/arbitrage";
import { listArbitragePage, persistOpportunities } from "@/lib/arbitrage/store";
import type { ArbitrageOpportunity } from "@/lib/arbitrage/scanner";

function opportunity(n: number, overrides: Partial<{ category: string; profit: number; title: string }> = {}): ArbitrageOpportunity {
  const profit = overrides.profit ?? 500 + n * 100;
  return {
    category: overrides.category ?? "Home & Kitchen",
    ebay: {
      itemId: `v1|${1000 + n}|0`,
      title: overrides.title ?? `Test Product Number ${n} With Long Title`,
      priceCents: 2000 + n * 100,
      salesLast30d: 10 + n,
      url: `https://www.ebay.com/itm/${1000 + n}`,
      imageUrl: "https://i.ebayimg.com/t.jpg",
    },
    amazon: {
      asin: `B0TEST${String(n).padStart(4, "0")}`,
      title: `Test Product ${n}`,
      priceCents: 1000,
      url: `https://www.amazon.com/dp/B0TEST${String(n).padStart(4, "0")}`,
    },
    margin: {
      estimatedFeeCents: 295,
      estimatedProfitCents: profit,
      marginPct: Math.round((profit / (2000 + n * 100)) * 100),
    },
  };
}

beforeAll(() => {
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: process.cwd(),
    env: process.env,
    stdio: "pipe",
  });
}, 120_000);

beforeEach(async () => {
  await db.arbitrageItem.deleteMany();
  await db.scanCache.deleteMany();
  await db.listing.deleteMany();
  await db.product.deleteMany();
  await db.user.deleteMany();
});

describe("persistOpportunities", () => {
  it("inserts new items and updates (not duplicates) repeats", async () => {
    expect(await persistOpportunities([opportunity(1), opportunity(2)])).toBe(2);
    // Same eBay item again with a new price: updated in place.
    const again = opportunity(1);
    again.ebay.priceCents = 9999;
    expect(await persistOpportunities([again])).toBe(0);
    expect(await db.arbitrageItem.count()).toBe(2);
    const updated = await db.arbitrageItem.findUniqueOrThrow({
      where: { ebayItemId: "v1|1001|0" },
    });
    expect(updated.ebayPriceCents).toBe(9999);
  });
});

describe("listArbitragePage", () => {
  const base = {
    sortKey: "profit" as const,
    sortDesc: true,
    category: "all",
    minMarginPct: 0,
    query: "",
  };

  it("paginates with a stable sort", async () => {
    await persistOpportunities(
      Array.from({ length: 30 }, (_, i) => opportunity(i)),
    );
    const user = await db.user.create({
      data: { email: "t@t.dev", passwordHash: "x", name: "T" },
    });

    const page1 = await listArbitragePage(user.id, { ...base, page: 1 });
    expect(page1.total).toBe(30);
    expect(page1.pageCount).toBe(2);
    expect(page1.rows).toHaveLength(25);
    // profit desc: first row is the highest-profit item (n=29)
    expect(page1.rows[0].profitCents).toBe(500 + 29 * 100);

    const page2 = await listArbitragePage(user.id, { ...base, page: 2 });
    expect(page2.rows).toHaveLength(5);
    const seen = new Set(page1.rows.map((r) => r.asin));
    for (const r of page2.rows) expect(seen.has(r.asin)).toBe(false);
  });

  it("filters by category, margin, and title search", async () => {
    await persistOpportunities([
      opportunity(1, { category: "Electronics", title: "Wireless Bluetooth Speaker Waterproof" }),
      opportunity(2, { category: "Pet Supplies", title: "Dog Grooming Brush Deluxe Kit" }),
      opportunity(3, { category: "Pet Supplies", profit: 100, title: "Cat Litter Mat Extra Large" }),
    ]);
    const user = await db.user.create({
      data: { email: "t2@t.dev", passwordHash: "x", name: "T" },
    });

    const cat = await listArbitragePage(user.id, { ...base, page: 1, category: "Pet Supplies" });
    expect(cat.total).toBe(2);

    // Case-insensitive substring match.
    const search = await listArbitragePage(user.id, { ...base, page: 1, query: "bluetooth speaker" });
    expect(search.total).toBe(1);
    const noHit = await listArbitragePage(user.id, { ...base, page: 1, query: "speaker bluetooth" });
    expect(noHit.total).toBe(0);

    const margin = await listArbitragePage(user.id, {
      ...base,
      page: 1,
      minMarginPct: 15,
    });
    expect(margin.rows.every((r) => r.marginPct >= 15)).toBe(true);
  });

  it("flags items the user already sells", async () => {
    await persistOpportunities([opportunity(7)]);
    const user = await db.user.create({
      data: { email: "t3@t.dev", passwordHash: "x", name: "T" },
    });
    await db.product.create({
      data: {
        userId: user.id,
        sku: "B0TEST0007",
        title: "t", description: "t", category: "t",
        supplierName: "Amazon", supplierProductId: "B0TEST0007",
        supplierUrl: "https://a", costCents: 1000, supplierStock: 50,
        shippingCostCents: 0, suggestedPriceCents: 2000, sourceScore: 0,
      },
    });
    const page = await listArbitragePage(user.id, { ...base, page: 1 });
    expect(page.rows[0].mirrored).toBe(true);
  });
});

describe("scanMore (sandbox)", () => {
  it("adds items to the database and advances its cursor", async () => {
    const first = await scanMore();
    expect(first.added).toBeGreaterThan(0);
    const countAfterFirst = await db.arbitrageItem.count();
    expect(countAfterFirst).toBe(first.added);

    const second = await scanMore();
    const countAfterSecond = await db.arbitrageItem.count();
    expect(countAfterSecond).toBe(first.added + second.added);
  });
});

// Integration tests for the sync engine and order import against a real
// (throwaway) SQLite database — DATABASE_URL is set to prisma/test.db in
// vitest.config.ts.

import { execSync } from "node:child_process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runSync, fixIssue } from "@/lib/sync/engine";
import { importOrders } from "@/lib/orders/import";
import { MockEbayClient } from "@/lib/ebay/mock";
import { MockAmazonScraper } from "@/lib/mirror/mock-amazon";
import { mirrorUrl } from "@/lib/mirror/pipeline";
import { ebayFeeCents } from "@/lib/fees";
import type { EbayClient, ListingUpdate, RemoteOrder } from "@/lib/ebay/client";
import type { SupplierProductState, SupplierProvider } from "@/lib/sourcing/provider";

class FakeProvider implements SupplierProvider {
  constructor(public state: SupplierProductState) {}
  async getTrendingCandidates() {
    return [];
  }
  async getCandidate() {
    return null;
  }
  async getProductState() {
    return this.state;
  }
}

class RecordingEbay implements EbayClient {
  updates: { id: string; update: ListingUpdate }[] = [];
  ended: string[] = [];
  async createListing() {
    return { ebayListingId: "110000000001" };
  }
  async updateListing(id: string, update: ListingUpdate) {
    this.updates.push({ id, update });
  }
  async endListing(id: string) {
    this.ended.push(id);
  }
  async getOrders(): Promise<RemoteOrder[]> {
    return [];
  }
}

async function createUserWithActiveListing() {
  const user = await db.user.create({
    data: {
      email: `t-${Date.now()}-${Math.random()}@test.dev`,
      passwordHash: "x",
      name: "Test",
    },
  });
  const product = await db.product.create({
    data: {
      userId: user.id,
      sku: "T-1",
      title: "Test product",
      description: "d",
      category: "Test",
      supplierName: "Test Supplier",
      supplierProductId: "T-1",
      supplierUrl: "https://example.com",
      costCents: 600,
      supplierStock: 100,
      shippingCostCents: 450,
      suggestedPriceCents: 2299,
      sourceScore: 80,
    },
  });
  const listing = await db.listing.create({
    data: {
      userId: user.id,
      productId: product.id,
      title: "Test product - Fast Free Shipping",
      description: "d",
      priceCents: 2299,
      quantity: 5,
      imageUrlsJson: JSON.stringify(["https://example.com/a.jpg"]),
      status: "ACTIVE",
      ebayListingId: "110555000111",
      publishedAt: new Date(Date.now() - 10 * 86_400_000),
    },
  });
  return { user, product, listing };
}

beforeAll(() => {
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "pipe",
  });
});

beforeEach(async () => {
  await db.syncIssue.deleteMany();
  await db.syncRun.deleteMany();
  await db.order.deleteMany();
  await db.listing.deleteMany();
  await db.product.deleteMany();
  await db.ebayConnection.deleteMany();
  await db.session.deleteMany();
  await db.user.deleteMany();
});

describe("runSync", () => {
  it("auto-fixes risky issues: revises eBay and mirrors the DB", async () => {
    const { user, listing } = await createUserWithActiveListing();
    const ebay = new RecordingEbay();
    const summary = await runSync(user.id, {
      provider: new FakeProvider({ stock: 0, costCents: 600 }),
      ebay,
    });

    expect(summary.issuesAutoFixed).toBe(1);
    expect(ebay.updates).toEqual([
      { id: "110555000111", update: { quantity: 0 } },
    ]);
    const updated = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.quantity).toBe(0);

    const issues = await db.syncIssue.findMany({ where: { userId: user.id } });
    expect(issues).toHaveLength(1);
    expect(issues[0].resolution).toBe("AUTO_FIXED");
  });

  it("ends the listing when the supplier is gone", async () => {
    const { user, listing } = await createUserWithActiveListing();
    const ebay = new RecordingEbay();
    await runSync(user.id, { provider: new FakeProvider(null), ebay });

    expect(ebay.ended).toEqual(["110555000111"]);
    const updated = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.status).toBe("ENDED");
  });

  it("does not pile up duplicate OPEN issues across repeated runs", async () => {
    const { user, listing } = await createUserWithActiveListing();
    await db.listing.update({ where: { id: listing.id }, data: { quantity: 2 } });
    const deps = {
      provider: new FakeProvider({ stock: 100, costCents: 600 }),
      ebay: new RecordingEbay(),
    };
    await runSync(user.id, deps);
    await runSync(user.id, deps);
    await runSync(user.id, deps);

    const open = await db.syncIssue.findMany({
      where: { userId: user.id, resolution: "OPEN" },
    });
    expect(open).toHaveLength(1);
  });

  it("closes OPEN issues that no longer apply", async () => {
    const { user, listing } = await createUserWithActiveListing();
    await db.listing.update({ where: { id: listing.id }, data: { quantity: 2 } });
    const ebay = new RecordingEbay();
    // Restock opportunity (flag-only) files an OPEN issue…
    await runSync(user.id, { provider: new FakeProvider({ stock: 100, costCents: 600 }), ebay });
    // …then supplier stock drops to exactly the listed quantity — nothing wrong anymore.
    const summary = await runSync(user.id, {
      provider: new FakeProvider({ stock: 2, costCents: 600 }),
      ebay,
    });

    expect(summary.issuesFound).toBe(0);
    const open = await db.syncIssue.findMany({
      where: { userId: user.id, resolution: "OPEN" },
    });
    expect(open).toHaveLength(0);
    const fixed = await db.syncIssue.findMany({
      where: { userId: user.id, resolution: "FIXED" },
    });
    expect(fixed).toHaveLength(1);
  });

  it("refreshes the product supplier snapshot", async () => {
    const { user, product } = await createUserWithActiveListing();
    await runSync(user.id, {
      provider: new FakeProvider({ stock: 42, costCents: 777 }),
      ebay: new RecordingEbay(),
    });
    const updated = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(updated.supplierStock).toBe(42);
    expect(updated.costCents).toBe(777);
  });
});

describe("runSync — review-fix behaviors", () => {
  it("does not auto-fix a restock opportunity", async () => {
    const { user, listing } = await createUserWithActiveListing();
    await db.listing.update({ where: { id: listing.id }, data: { quantity: 2 } });
    const ebay = new RecordingEbay();
    const summary = await runSync(user.id, {
      provider: new FakeProvider({ stock: 100, costCents: 600 }),
      ebay,
    });

    expect(summary.issuesFound).toBe(1);
    expect(summary.issuesAutoFixed).toBe(0);
    expect(ebay.updates).toEqual([]);
    const issue = await db.syncIssue.findFirstOrThrow({ where: { userId: user.id } });
    expect(issue.type).toBe("STOCK_DRIFT");
    expect(issue.resolution).toBe("OPEN");
    const unchanged = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(unchanged.quantity).toBe(2);
  });

  it("respects an ignore while the condition persists, and re-flags after it clears and recurs", async () => {
    const { user, listing } = await createUserWithActiveListing();
    await db.listing.update({ where: { id: listing.id }, data: { quantity: 2 } });
    const ebay = new RecordingEbay();
    // Restock drift is flag-only, so it produces a persistent OPEN issue.
    const restock = { provider: new FakeProvider({ stock: 100, costCents: 600 }), ebay };
    const settled = { provider: new FakeProvider({ stock: 2, costCents: 600 }), ebay };

    await runSync(user.id, restock);
    const issue = await db.syncIssue.findFirstOrThrow({
      where: { userId: user.id, resolution: "OPEN" },
    });
    await db.syncIssue.update({
      where: { id: issue.id },
      data: { resolution: "IGNORED", resolvedAt: new Date() },
    });

    // Condition persists: the ignore holds — nothing new is filed.
    const second = await runSync(user.id, restock);
    expect(second.issuesFound).toBe(0);
    expect(
      await db.syncIssue.count({ where: { userId: user.id, resolution: "OPEN" } }),
    ).toBe(0);

    // Condition clears (the ignore expires), then recurs: flagged again.
    await runSync(user.id, settled);
    const fourth = await runSync(user.id, restock);
    expect(fourth.issuesFound).toBe(1);
    expect(
      await db.syncIssue.count({ where: { userId: user.id, resolution: "OPEN" } }),
    ).toBe(1);
  });
});

describe("mirrorUrl", () => {
  const scraper = new MockAmazonScraper(() => 20000);

  it("creates a product and an eBay-ready draft from an Amazon URL", async () => {
    const { user } = await createUserWithActiveListing();
    const outcome = await mirrorUrl(
      user.id,
      "https://www.amazon.com/Some-Product/dp/B0ABCD1234/ref=sr_1_1",
      scraper,
    );

    expect(outcome.ok).toBe(true);
    const listing = await db.listing.findUniqueOrThrow({
      where: { id: outcome.listingId! },
      include: { product: true },
    });
    expect(listing.status).toBe("DRAFT");
    expect(listing.title.length).toBeLessThanOrEqual(80);
    expect(listing.quantity).toBeGreaterThan(0);
    expect(listing.product.sku).toBe("B0ABCD1234");
    expect(listing.product.supplierUrl).toBe("https://www.amazon.com/dp/B0ABCD1234");
    // Priced above cost with a positive margin after fees.
    expect(listing.priceCents).toBeGreaterThan(listing.product.costCents);
    expect(JSON.parse(listing.imageUrlsJson).length).toBeGreaterThan(0);
  });

  it("rejects a duplicate ASIN for the same user", async () => {
    const { user } = await createUserWithActiveListing();
    await mirrorUrl(user.id, "https://www.amazon.com/dp/B0ABCD1234", scraper);
    const dup = await mirrorUrl(
      user.id,
      "https://www.amazon.com/other-slug/dp/B0ABCD1234?ref=x",
      scraper,
    );
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain("Already imported");
  });

  it("prices against a known eBay comp when one is supplied", async () => {
    const { user } = await createUserWithActiveListing();
    const outcome = await mirrorUrl(
      user.id,
      "https://www.amazon.com/dp/B0ABCD1234",
      scraper,
      { marketPriceCents: 4999 },
    );
    expect(outcome.ok).toBe(true);
    const listing = await db.listing.findUniqueOrThrow({
      where: { id: outcome.listingId! },
    });
    // Charm-priced undercut of the $49.99 comp, not the generic markup.
    expect(listing.priceCents).toBeLessThan(4999);
    expect(listing.priceCents).toBeGreaterThan(4000);
    expect(listing.priceCents % 100).toBe(99);
  });

  it("fails cleanly on a non-product URL", async () => {
    const { user } = await createUserWithActiveListing();
    const outcome = await mirrorUrl(user.id, "https://example.com/dp/nope", scraper);
    expect(outcome.ok).toBe(false);
    expect(await db.product.count({ where: { userId: user.id, sku: "NOPE" } })).toBe(0);
  });
});

describe("fixIssue", () => {
  it("applies the fix for an OPEN issue and marks it FIXED", async () => {
    const { user, listing } = await createUserWithActiveListing();
    await db.listing.update({ where: { id: listing.id }, data: { quantity: 2 } });
    const ebay = new RecordingEbay();
    const deps = { provider: new FakeProvider({ stock: 100, costCents: 600 }), ebay };
    await runSync(user.id, deps);
    const issue = await db.syncIssue.findFirstOrThrow({
      where: { userId: user.id, resolution: "OPEN" },
    });

    const error = await fixIssue(user.id, issue.id, deps);
    expect(error).toBeNull();
    expect(ebay.updates).toEqual([{ id: "110555000111", update: { quantity: 5 } }]);
    const updated = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.quantity).toBe(5);
    const resolved = await db.syncIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(resolved.resolution).toBe("FIXED");
  });

  it("ends the listing when the condition morphed into supplier-gone", async () => {
    const { user, listing } = await createUserWithActiveListing();
    await db.listing.update({ where: { id: listing.id }, data: { quantity: 2 } });
    const ebay = new RecordingEbay();
    await runSync(user.id, {
      provider: new FakeProvider({ stock: 100, costCents: 600 }),
      ebay,
    });
    const issue = await db.syncIssue.findFirstOrThrow({
      where: { userId: user.id, resolution: "OPEN", type: "STOCK_DRIFT" },
    });

    // By the time the user clicks Fix, the supplier delisted the product.
    const error = await fixIssue(user.id, issue.id, {
      provider: new FakeProvider(null),
      ebay,
    });
    expect(error).toBeNull();
    expect(ebay.ended).toEqual(["110555000111"]);
    const updated = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.status).toBe("ENDED");
  });

  it("refuses cross-user access", async () => {
    const { user } = await createUserWithActiveListing();
    const deps = {
      provider: new FakeProvider({ stock: 0, costCents: 600 }),
      ebay: new RecordingEbay(),
    };
    await runSync(user.id, deps);
    const issue = await db.syncIssue.findFirstOrThrow({ where: { userId: user.id } });

    const error = await fixIssue("someone-else", issue.id, deps);
    expect(error).not.toBeNull();
  });
});

describe("importOrders (with the sandbox eBay client)", () => {
  it("imports deterministic orders with correct fee snapshots, idempotently", async () => {
    const { user, listing, product } = await createUserWithActiveListing();
    const ebay = new MockEbayClient();

    const first = await importOrders(user.id, ebay);
    expect(first.imported).toBeGreaterThan(0);

    const orders = await db.order.findMany({ where: { userId: user.id } });
    expect(orders).toHaveLength(first.imported);
    for (const o of orders) {
      expect(o.ebayFeeCents).toBe(
        ebayFeeCents({
          quantity: o.quantity,
          salePriceCents: o.salePriceCents,
          shippingChargedCents: o.shippingChargedCents,
        }),
      );
      expect(o.cogsCents).toBe(product.costCents * o.quantity);
      expect(o.listingId).toBe(listing.id);
      expect(o.saleDate.getTime()).toBeGreaterThanOrEqual(
        listing.publishedAt!.getTime() - 86_400_000,
      );
    }

    const second = await importOrders(user.id, ebay);
    expect(second.imported).toBe(0);
    expect(await db.order.count({ where: { userId: user.id } })).toBe(first.imported);
  });

  it("decrements listing quantity as units sell, never below zero", async () => {
    const { user, listing } = await createUserWithActiveListing();
    await importOrders(user.id, new MockEbayClient());
    const updated = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.quantity).toBeGreaterThanOrEqual(0);
    expect(updated.quantity).toBeLessThanOrEqual(5);
  });
});

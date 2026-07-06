import { describe, expect, it } from "vitest";
import { MockSupplierProvider, driftedState } from "@/lib/sourcing/mock-supplier";
import { CATALOG } from "@/lib/sourcing/catalog";

describe("MockSupplierProvider", () => {
  it("is deterministic within a day", async () => {
    const a = new MockSupplierProvider(() => 20000);
    const b = new MockSupplierProvider(() => 20000);
    expect(await a.getTrendingCandidates()).toEqual(await b.getTrendingCandidates());
    expect(await a.getProductState("MS-1001")).toEqual(
      await b.getProductState("MS-1001"),
    );
  });

  it("drifts across days", async () => {
    const day1 = await new MockSupplierProvider(() => 20000).getTrendingCandidates();
    const day2 = await new MockSupplierProvider(() => 20001).getTrendingCandidates();
    expect(day1).not.toEqual(day2);
  });

  it("excludes gone products from the feed and returns null state for them", async () => {
    // Find a (product, day) pair where the product is gone.
    let found: { id: string; day: number } | null = null;
    outer: for (const item of CATALOG) {
      for (let day = 20000; day < 20100; day++) {
        if (driftedState(item, day).gone) {
          found = { id: item.id, day };
          break outer;
        }
      }
    }
    expect(found).not.toBeNull();
    const provider = new MockSupplierProvider(() => found!.day);
    const feed = await provider.getTrendingCandidates();
    expect(feed.some((c) => c.supplierProductId === found!.id)).toBe(false);
    expect(await provider.getProductState(found!.id)).toBeNull();
  });

  it("returns null state for unknown products", async () => {
    const provider = new MockSupplierProvider(() => 20000);
    expect(await provider.getProductState("NOPE-1")).toBeNull();
  });

  it("keeps cost within the documented ±12% band", () => {
    for (const item of CATALOG.slice(0, 5)) {
      for (let day = 20000; day < 20030; day++) {
        const s = driftedState(item, day);
        expect(s.costCents).toBeGreaterThanOrEqual(Math.floor(item.baseCostCents * 0.88));
        expect(s.costCents).toBeLessThanOrEqual(Math.ceil(item.baseCostCents * 1.12));
      }
    }
  });
});

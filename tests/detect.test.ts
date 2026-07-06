import { describe, expect, it } from "vitest";
import { detectIssues } from "@/lib/sync/detect";
import { LISTING_QUANTITY_CAP } from "@/lib/listings/generate";
import { ebayFeeCents, netProfitCents } from "@/lib/fees";

const healthyListing = { priceCents: 2299, quantity: 5 };
const product = { shippingCostCents: 450 };

describe("detectIssues", () => {
  it("reports nothing when listing matches supplier truth", () => {
    const issues = detectIssues(healthyListing, product, {
      stock: 100,
      costCents: 600,
    });
    expect(issues).toEqual([]);
  });

  it("flags SUPPLIER_GONE with an end-listing fix when the product is delisted", () => {
    const issues = detectIssues(healthyListing, product, null);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("SUPPLIER_GONE");
    expect(issues[0].fix).toEqual({ kind: "end_listing" });
  });

  it("flags OUT_OF_STOCK with a zero-quantity fix", () => {
    const issues = detectIssues(healthyListing, product, { stock: 0, costCents: 600 });
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("OUT_OF_STOCK");
    expect(issues[0].fix).toEqual({ kind: "set_quantity", quantity: 0 });
  });

  it("does not re-flag OUT_OF_STOCK once quantity is already zero", () => {
    const issues = detectIssues({ priceCents: 2299, quantity: 0 }, product, {
      stock: 0,
      costCents: 600,
    });
    expect(issues).toEqual([]);
  });

  it("flags oversell risk when supplier stock drops below listed quantity", () => {
    const issues = detectIssues({ priceCents: 2299, quantity: 5 }, product, {
      stock: 3,
      costCents: 600,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("STOCK_DRIFT");
    expect(issues[0].fix).toEqual({ kind: "set_quantity", quantity: 3 });
    expect(issues[0].details.message).toContain("oversell");
  });

  it("flags restock opportunity when quantity can go back up to the cap", () => {
    const issues = detectIssues({ priceCents: 2299, quantity: 0 }, product, {
      stock: 50,
      costCents: 600,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("STOCK_DRIFT");
    expect(issues[0].fix).toEqual({
      kind: "set_quantity",
      quantity: LISTING_QUANTITY_CAP,
    });
  });

  it("flags COST_RISE with a profitable reprice when cost makes the listing loss-making", () => {
    const state = { stock: 100, costCents: 2100 };
    const issues = detectIssues(healthyListing, product, state);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("COST_RISE");
    const fix = issues[0].fix;
    if (fix.kind !== "set_price") throw new Error("expected price fix");
    const netAtNewPrice = netProfitCents({
      quantity: 1,
      salePriceCents: fix.priceCents,
      shippingChargedCents: 0,
      ebayFeeCents: ebayFeeCents({
        quantity: 1,
        salePriceCents: fix.priceCents,
        shippingChargedCents: 0,
      }),
      shippingCostCents: product.shippingCostCents,
      cogsCents: state.costCents,
    });
    expect(netAtNewPrice).toBeGreaterThan(0);
  });

  it("can report stock and cost issues together", () => {
    const issues = detectIssues({ priceCents: 2299, quantity: 8 }, product, {
      stock: 2,
      costCents: 2100,
    });
    const types = issues.map((i) => i.type).sort();
    expect(types).toEqual(["COST_RISE", "STOCK_DRIFT"]);
  });
});

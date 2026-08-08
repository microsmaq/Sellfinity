import { describe, expect, it } from "vitest";
import { EBAY_PER_ORDER_FEE_CENTS } from "@/lib/fees";
import {
  VERIFIED_MARGIN_TARGET_BPS,
  VERIFIED_PROFIT_TARGET_CENTS,
  verifiedProfitProtectionDecision,
} from "@/lib/orders/profit-protection-policy";

const feeBps = 1_325;

function futureProfit(priceCents: number, costCents: number): number {
  return priceCents - Math.ceil((priceCents * feeBps) / 10_000) - EBAY_PER_ORDER_FEE_CENTS - costCents;
}

describe("verified profit protection", () => {
  it("does nothing when the verified order already earned at least 5%", () => {
    const result = verifiedProfitProtectionDecision({
      currentListingPriceCents: 2_000,
      orderQuantity: 1,
      realizedRevenueCents: 2_000,
      realizedEbayFeeCents: 295,
      verifiedAmazonCostCents: 1_000,
    });

    expect(result.action).toBe("not_required");
  });

  it("raises a proven unprofitable listing to the lower protected target", () => {
    const result = verifiedProfitProtectionDecision({
      currentListingPriceCents: 1_500,
      orderQuantity: 1,
      realizedRevenueCents: 1_500,
      realizedEbayFeeCents: 229,
      verifiedAmazonCostCents: 1_300,
    });

    expect(result.action).toBe("reprice");
    if (result.action !== "reprice") return;
    const profit = futureProfit(result.targetPriceCents, 1_300);
    expect(profit * 10_000).toBeGreaterThanOrEqual(result.targetPriceCents * VERIFIED_MARGIN_TARGET_BPS);
    expect(profit).toBeLessThan(VERIFIED_PROFIT_TARGET_CENTS);
  });

  it("caps an expensive item's target at $7 net instead of requiring 5%", () => {
    const result = verifiedProfitProtectionDecision({
      currentListingPriceCents: 21_000,
      orderQuantity: 1,
      realizedRevenueCents: 21_000,
      realizedEbayFeeCents: 2_812,
      verifiedAmazonCostCents: 20_000,
    });

    expect(result.action).toBe("reprice");
    if (result.action !== "reprice") return;
    const profit = futureProfit(result.targetPriceCents, 20_000);
    expect(profit).toBe(VERIFIED_PROFIT_TARGET_CENTS);
    expect(profit * 10_000).toBeLessThan(result.targetPriceCents * VERIFIED_MARGIN_TARGET_BPS);
  });

  it("recognizes when a later listing price already protects the proven loss", () => {
    const result = verifiedProfitProtectionDecision({
      currentListingPriceCents: 1_800,
      orderQuantity: 1,
      realizedRevenueCents: 1_500,
      realizedEbayFeeCents: 229,
      verifiedAmazonCostCents: 1_300,
    });

    expect(result.action).toBe("already_protected");
  });
});

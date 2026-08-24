import { describe, expect, it } from "vitest";
import { allocateCents, parseOrderFinancials } from "@/lib/ebay/order-financials";

describe("eBay finalized order earnings", () => {
  it("separates transaction fees, advertising, and earnings", () => {
    const result = parseOrderFinancials({
      orderId: "ORDER-1",
      orderLastModifiedDate: "2026-08-24T12:00:00Z",
      orderEarningsSummary: {
        grossAmount: { value: "12.34" },
        orderEarnings: { value: "9.15" },
        refunds: { value: "0.00" },
        expenses: {
          value: "3.19",
          marketplaceFees: [
            { feeType: "FINAL_VALUE_FEE", amount: { value: "2.08" } },
            { feeType: "AD_FEE", amount: { value: "1.11" } },
          ],
          shippingLabels: { value: "0.00" },
        },
      },
    }, "ORDER-1");

    expect(result).toMatchObject({
      grossAmountCents: 1234,
      orderEarningsCents: 915,
      transactionFeeCents: 208,
      advertisingFeeCents: 111,
      otherFeeCents: 0,
    });
  });

  it("allocates checkout-order totals without losing cents", () => {
    const allocated = allocateCents(319, [800, 434]);
    expect(allocated).toHaveLength(2);
    expect(allocated.reduce((sum, amount) => sum + amount, 0)).toBe(319);
  });
});

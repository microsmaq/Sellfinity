import { describe, expect, it } from "vitest";
import { ORDER_IMPORT_LOOKBACK_DAYS } from "@/lib/orders/import-window";

describe("order import lookback", () => {
  it("rechecks older orders for late eBay cancellations", () => {
    expect(ORDER_IMPORT_LOOKBACK_DAYS).toBeGreaterThanOrEqual(90);
  });
});

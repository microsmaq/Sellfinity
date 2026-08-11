import { describe, expect, it } from "vitest";
import { AUTO_RESTOCK_TARGET, shouldAutoRestock } from "@/lib/orders/auto-restock-policy";

describe("fulfilled listing auto-restock policy", () => {
  it("refills confirmed stock of zero or one", () => {
    expect(shouldAutoRestock(0)).toBe(true);
    expect(shouldAutoRestock(1)).toBe(true);
    expect(AUTO_RESTOCK_TARGET).toBe(5);
  });

  it("leaves stock of two or more unchanged", () => {
    expect(shouldAutoRestock(2)).toBe(false);
    expect(shouldAutoRestock(5)).toBe(false);
  });

  it("skips unknown and invalid quantities", () => {
    expect(shouldAutoRestock(null)).toBe(false);
    expect(shouldAutoRestock(-1)).toBe(false);
  });
});

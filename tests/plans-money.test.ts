import { describe, expect, it } from "vitest";
import { planFor, remainingListingSlots } from "@/lib/plans";
import { formatCents, parseDollarsToCents } from "@/lib/money";

describe("plans", () => {
  it("limits FREE to 10 active listings", () => {
    expect(remainingListingSlots("FREE", 0)).toBe(10);
    expect(remainingListingSlots("FREE", 10)).toBe(0);
    expect(remainingListingSlots("FREE", 15)).toBe(0);
  });

  it("gives SCALE unlimited slots", () => {
    expect(remainingListingSlots("SCALE", 10_000)).toBe(Infinity);
  });

  it("falls back to FREE for unknown plan strings", () => {
    expect(planFor("ENTERPRISE").id).toBe("FREE");
  });

  it("only paid plans get auto-fix", () => {
    expect(planFor("FREE").autoFix).toBe(false);
    expect(planFor("PRO").autoFix).toBe(true);
  });
});

describe("money", () => {
  it("formats cents as dollars", () => {
    expect(formatCents(123456)).toBe("$1234.56");
    expect(formatCents(-50)).toBe("-$0.50");
    expect(formatCents(0)).toBe("$0.00");
  });

  it("parses dollar strings", () => {
    expect(parseDollarsToCents("12.99")).toBe(1299);
    expect(parseDollarsToCents("$5")).toBe(500);
    expect(parseDollarsToCents(" 7.5 ")).toBe(750);
    expect(parseDollarsToCents("abc")).toBeNull();
    expect(parseDollarsToCents("1.999")).toBeNull();
    expect(parseDollarsToCents("-3")).toBeNull();
  });
});

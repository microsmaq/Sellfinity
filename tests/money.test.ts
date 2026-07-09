import { describe, expect, it } from "vitest";
import { formatCents, parseDollarsToCents } from "@/lib/money";

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

import { describe, expect, it } from "vitest";
import { assessProfitableSalePriceLock, assessVerifiedWinner } from "@/lib/listings/winner-policy";

const now = new Date("2026-08-16T20:00:00.000Z");

describe("verified winner policy", () => {
  it("keeps a one-sale price lock separate from Verified Winner status", () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    const orders = [
      { saleDate: new Date("2026-08-18T10:00:00.000Z"), quantity: 1, profitCents: 125 },
    ];
    const winner = assessVerifiedWinner(orders, now);
    const lock = assessProfitableSalePriceLock(orders, now);

    expect(winner.isWinner).toBe(false);
    expect(lock.isLocked).toBe(true);
    expect(lock.profitableUnits).toBe(1);
    expect(lock.protectedUntil).toEqual(new Date("2026-08-25T10:00:00.000Z"));
  });

  it("marks repeat profitable sales across multiple days as a winner", () => {
    const result = assessVerifiedWinner([
      { saleDate: new Date("2026-08-15T12:00:00.000Z"), quantity: 1, profitCents: 200 },
      { saleDate: new Date("2026-08-16T10:00:00.000Z"), quantity: 1, profitCents: 335 },
      { saleDate: new Date("2026-08-16T15:00:00.000Z"), quantity: 1, profitCents: 335 },
    ], now);

    expect(result.isWinner).toBe(true);
    expect(result.profitableUnits).toBe(3);
    expect(result.profitableSaleDays).toBe(2);
  });

  it("does not mark one-day spikes as consistent winners", () => {
    const result = assessVerifiedWinner([
      { saleDate: new Date("2026-08-16T10:00:00.000Z"), quantity: 3, profitCents: 500 },
    ], now);
    expect(result.isWinner).toBe(false);
  });

  it("releases the price lock after seven days without a profitable sale", () => {
    const result = assessVerifiedWinner([
      { saleDate: new Date("2026-08-01T10:00:00.000Z"), quantity: 1, profitCents: 200 },
      { saleDate: new Date("2026-08-02T10:00:00.000Z"), quantity: 1, profitCents: 200 },
      { saleDate: new Date("2026-08-08T10:00:00.000Z"), quantity: 1, profitCents: 200 },
    ], now);
    expect(result.isWinner).toBe(false);
  });

  it("ignores unprofitable sales when establishing a winner", () => {
    const result = assessVerifiedWinner([
      { saleDate: new Date("2026-08-15T10:00:00.000Z"), quantity: 2, profitCents: -50 },
      { saleDate: new Date("2026-08-16T10:00:00.000Z"), quantity: 1, profitCents: 200 },
    ], now);
    expect(result.isWinner).toBe(false);
  });
});

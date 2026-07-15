import { describe, expect, it } from "vitest";
import {
  ARBITRAGE_DAILY_TARGET,
  getLosAngelesCronTime,
  shouldRunDailyArbitrageCron,
} from "@/lib/cron/arbitrage-schedule";

describe("daily arbitrage cron schedule", () => {
  it("targets 500 new opportunities", () => {
    expect(ARBITRAGE_DAILY_TARGET).toBe(500);
  });

  it("runs at 3 AM Los Angeles time during daylight saving time", () => {
    const scheduled = new Date("2026-07-15T10:00:00.000Z");
    const otherUtcSlot = new Date("2026-07-15T11:00:00.000Z");

    expect(getLosAngelesCronTime(scheduled)).toEqual({
      date: "2026-07-15",
      hour: 3,
    });
    expect(shouldRunDailyArbitrageCron(scheduled)).toBe(true);
    expect(shouldRunDailyArbitrageCron(otherUtcSlot)).toBe(false);
  });

  it("runs at 3 AM Los Angeles time during standard time", () => {
    const otherUtcSlot = new Date("2026-01-15T10:00:00.000Z");
    const scheduled = new Date("2026-01-15T11:00:00.000Z");

    expect(shouldRunDailyArbitrageCron(otherUtcSlot)).toBe(false);
    expect(getLosAngelesCronTime(scheduled)).toEqual({
      date: "2026-01-15",
      hour: 3,
    });
    expect(shouldRunDailyArbitrageCron(scheduled)).toBe(true);
  });
});

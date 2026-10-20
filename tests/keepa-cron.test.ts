import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
const mocks = vi.hoisted(() => ({ advance: vi.fn(), heartbeat: vi.fn() }));
vi.mock("@/lib/keepa/discovery", () => ({ advanceKeepaDiscovery: mocks.advance, recordKeepaSchedulerHeartbeat: mocks.heartbeat }));
vi.mock("@/lib/keepa/reporting", () => ({ keepaRunTelemetry: vi.fn(async () => ({})) }));
import { GET } from "@/app/api/cron/keepa-discovery/route";
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("CRON_SECRET", "test-cron-secret"); mocks.advance.mockResolvedValue("PROGRESSED"); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("Keepa discovery cron", () => {
  it.each([undefined, "Bearer incorrect"])("rejects missing or invalid authorization: %s", async (authorization) => {
    const response = await GET(new NextRequest("https://sellfinity.example/api/cron/keepa-discovery", { headers: authorization ? { authorization } : {} }));
    expect(response.status).toBe(401); expect(mocks.advance).not.toHaveBeenCalled(); expect(mocks.heartbeat).not.toHaveBeenCalled();
  });
  it("rejects requests if the server secret is not configured", async () => {
    vi.stubEnv("CRON_SECRET", ""); const response = await GET(new NextRequest("https://sellfinity.example/api/cron/keepa-discovery", { headers: { authorization: "Bearer " } }));
    expect(response.status).toBe(401); expect(mocks.advance).not.toHaveBeenCalled(); expect(mocks.heartbeat).not.toHaveBeenCalled();
  });
  it("advances a bounded number of units with the configured secret", async () => {
    const response = await GET(new NextRequest("https://sellfinity.example/api/cron/keepa-discovery", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(response.status).toBe(200); expect(mocks.heartbeat).toHaveBeenCalledTimes(1); expect(mocks.advance).toHaveBeenCalledTimes(80);
    expect(await response.json()).toEqual({ ok: true, steps: 80, outcome: "PROGRESSED" });
  });
  it.each(["WAITING", "IDLE", "UNCONFIGURED", "ERROR"])("returns immediately on %s instead of looping on inactive work", async (outcome) => {
    mocks.advance.mockResolvedValueOnce(outcome);
    const response = await GET(new NextRequest("https://sellfinity.example/api/cron/keepa-discovery", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(mocks.advance).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ ok: outcome !== "ERROR", steps: 1, outcome });
  });
  it("drains paid responses and new products in one tick, then stops at a refill wait", async () => {
    mocks.advance.mockResolvedValueOnce("PROGRESSED").mockResolvedValueOnce("PROGRESSED").mockResolvedValueOnce("WAITING");
    const response = await GET(new NextRequest("https://sellfinity.example/api/cron/keepa-discovery", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(await response.json()).toEqual({ ok: true, steps: 3, outcome: "WAITING" });
  });
  it("stops starting new units after the soft deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    mocks.advance.mockImplementation(async () => { vi.setSystemTime(new Date(Date.now() + 21000)); return "PROGRESSED"; });
    await GET(new NextRequest("https://sellfinity.example/api/cron/keepa-discovery", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(mocks.advance).toHaveBeenCalledTimes(2);
  });
  it("configures only the Keepa cron for every-minute server-side execution", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(config.crons.find((row) => row.path === "/api/cron/keepa-discovery")?.schedule).toBe("* * * * *");
    expect(config.crons.filter((row) => row.path !== "/api/cron/keepa-discovery").every((row) => row.schedule.split(" ")[0] !== "*")).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  state: { upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  lists: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), count: vi.fn(), createMany: vi.fn() },
  items: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), createMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
  catalog: { findMany: vi.fn(), createMany: vi.fn() }, request: vi.fn(), transaction: vi.fn(), queryRaw: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { keepaDiscoveryState: mocks.state, keepaBestsellerList: mocks.lists, keepaDiscoveryItem: mocks.items, adminArbitrageProduct: mocks.catalog, $transaction: mocks.transaction } }));
vi.mock("@/lib/keepa/client", () => ({ requestKeepa: mocks.request }));
import { advanceKeepaDiscovery, recordKeepaSchedulerHeartbeat } from "@/lib/keepa/discovery";

const a = "B000000001", b = "B000000002", c = "B000000003";
const item = (asin = a) => ({ asin, categoryId: "123", categoryName: "Home", bestsellerRank: 1, status: "PENDING", responseJson: null, fetchedAt: null });
const tx = { keepaDiscoveryState: mocks.state, keepaBestsellerList: mocks.lists, keepaDiscoveryItem: mocks.items, adminArbitrageProduct: mocks.catalog, $queryRaw: mocks.queryRaw };
let state: { id: string; enabled: boolean; dailyTokenBudget: number; budgetDay: string; spentTokens: number; totalTokens: number; tokensLeft: number | null; tokenSampleAt: Date | null; refillRate: number; nextRunAt: Date | null; categoryStatus: string; lockOwner: string | null; lockUntil: Date | null; initializedAt: Date | null; autoQueueCategories: boolean; categoriesJson: string };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("KEEPA_API_KEY", "test-not-a-real-key");
  state = { id: "main", enabled: true, dailyTokenBudget: 1000, budgetDay: new Date().toISOString().slice(0, 10), spentTokens: 0, totalTokens: 0, tokensLeft: 100, tokenSampleAt: new Date(), refillRate: 20, nextRunAt: null, categoryStatus: "NONE", lockOwner: null, lockUntil: null, initializedAt: new Date(), autoQueueCategories: false, categoriesJson: "[]" };
  mocks.state.upsert.mockImplementation(async () => ({ ...state }));
  mocks.state.findUniqueOrThrow.mockImplementation(async () => ({ ...state }));
  mocks.state.update.mockImplementation(async ({ data }) => { Object.assign(state, Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value !== "object" || value === null || value instanceof Date))); return { ...state }; });
  mocks.state.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.enabled && !state.enabled) return { count: 0 };
    if (where.OR && state.lockUntil && state.lockUntil > new Date()) return { count: 0 };
    if (where.lockOwner && state.lockOwner !== where.lockOwner) return { count: 0 };
    Object.assign(state, Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value !== "object" || value === null || value instanceof Date)));
    return { count: 1 };
  });
  mocks.transaction.mockImplementation(async (callback) => typeof callback === "function" ? callback(tx) : Promise.all(callback));
  mocks.items.findMany.mockResolvedValue([]); mocks.items.updateMany.mockResolvedValue({ count: 0 }); mocks.items.createMany.mockResolvedValue({ count: 1 });
  mocks.items.count.mockResolvedValue(0);
  mocks.lists.findFirst.mockResolvedValue(null); mocks.lists.updateMany.mockResolvedValue({ count: 0 });
  mocks.lists.count.mockResolvedValue(0); mocks.lists.createMany.mockResolvedValue({ count: 1 });
  mocks.catalog.findMany.mockResolvedValue([]); mocks.catalog.createMany.mockResolvedValue({ count: 1 });
  mocks.request.mockResolvedValue({ status: 200, body: { tokensConsumed: 1, tokensLeft: 99, refillRate: 20, products: [{ asin: a, domainId: 1, productType: 0, title: "New product" }] } });
});
afterEach(() => vi.unstubAllEnvs());

describe("Keepa paid discovery safeguards", () => {
  it("makes no provider request without a key", async () => { vi.stubEnv("KEEPA_API_KEY", ""); await advanceKeepaDiscovery(); expect(mocks.request).not.toHaveBeenCalled(); });
  it("does nothing when paused or another worker holds the lease", async () => {
    state.enabled = false; await advanceKeepaDiscovery(); expect(mocks.request).not.toHaveBeenCalled();
    state.enabled = true; state.lockUntil = new Date(Date.now() + 60000); await advanceKeepaDiscovery(); expect(mocks.items.findMany).not.toHaveBeenCalled();
  });
  it("rechecks all catalog statuses before spending and fetches only the new ASIN", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a), item(b)] : []);
    mocks.catalog.findMany.mockResolvedValue([{ asin: b }]);
    await advanceKeepaDiscovery();
    expect(mocks.catalog.findMany).toHaveBeenCalledWith({ where: { asin: { in: [a, b] } }, select: { asin: true } });
    expect(mocks.items.updateMany).toHaveBeenCalledWith({ where: { asin: { in: [b] }, status: "PENDING" }, data: { status: "SKIPPED" } });
    expect(mocks.request).toHaveBeenCalledWith("product", { asin: a, stats: "90", days: "90", history: "1", update: "1", aplus: "1", videos: "1" });
    expect(mocks.catalog.createMany).not.toHaveBeenCalled(); // raw response saved before import
    expect(mocks.items.update).toHaveBeenCalledWith(expect.objectContaining({ where: { asin: a }, data: expect.objectContaining({ status: "SAVED", responseJson: expect.stringContaining('"title":"New product"') }) }));
  });
  it("uses no tokens when every pending ASIN is now in the catalog", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a)] : []);
    mocks.catalog.findMany.mockResolvedValue([{ asin: a }]); await advanceKeepaDiscovery(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it("deduplicates saved lists against the catalog, across categories and within a list before any detail calls", async () => {
    mocks.lists.findFirst.mockImplementation(async ({ where }) => where.status === "SAVED" ? { categoryId: "123", name: "Home", cursor: 0, responseJson: JSON.stringify({ bestSellersList: { asinList: [a, b, b, c] } }) } : null);
    mocks.catalog.findMany.mockResolvedValue([{ asin: a }]); mocks.items.createMany.mockResolvedValue({ count: 1 });
    await advanceKeepaDiscovery();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.items.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ asin: b, bestsellerRank: 2 }), expect.objectContaining({ asin: c, bestsellerRank: 4 })], skipDuplicates: true });
    expect(mocks.lists.update).toHaveBeenCalledWith({ where: { categoryId: "123" }, data: { cursor: 4, status: "DONE", queuedCount: { increment: 1 }, existingCount: { increment: 1 }, duplicateCount: { increment: 2 } } });
  });
  it("resumes beyond 1000 without refetching the list or truncating it", async () => {
    const asins = Array.from({ length: 1005 }, (_, i) => `B${String(i).padStart(9, "0")}`);
    mocks.lists.findFirst.mockImplementation(async ({ where }) => where.status === "SAVED" ? { categoryId: "123", name: "Home", cursor: 1000, responseJson: JSON.stringify({ bestSellersList: { asinList: asins } }) } : null);
    await advanceKeepaDiscovery(); expect(mocks.items.createMany.mock.calls[0][0].data.map((row: { asin: string }) => row.asin)).toEqual(asins.slice(1000));
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.lists.update.mock.calls[0][0].data.cursor).toBe(1005);
  });
  it("imports already-paid snapshots locally even while the token budget waits", async () => {
    state.nextRunAt = new Date(Date.now() + 86400000); state.spentTokens = 1000;
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "SAVED" ? [{ ...item(), status: "SAVED", responseJson: JSON.stringify({ asin: a, domainId: 1, productType: 0, title: "Saved product" }) }] : []);
    await advanceKeepaDiscovery(); expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.catalog.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ asin: a, status: "PENDING" })], skipDuplicates: true });
    expect(mocks.items.update).toHaveBeenCalledWith({ where: { asin: a }, data: { status: "IMPORTED", error: null } });
  });
  it("never overwrites an existing product if a browser import wins the race", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "SAVED" ? [{ ...item(), responseJson: JSON.stringify({ asin: a, domainId: 1, productType: 0, title: "Saved product" }) }] : []);
    mocks.catalog.createMany.mockResolvedValue({ count: 0 }); await advanceKeepaDiscovery();
    expect(mocks.items.update).toHaveBeenCalledWith({ where: { asin: a }, data: { status: "SKIPPED", error: null } }); expect(mocks.request).not.toHaveBeenCalled();
  });
  it("holds invalid/parent snapshots for review without another provider request", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "SAVED" ? [{ ...item(), responseJson: JSON.stringify({ asin: a, domainId: 1, productType: 5, title: "Parent" }) }] : []);
    await advanceKeepaDiscovery(); expect(mocks.catalog.createMany).not.toHaveBeenCalled(); expect(mocks.items.update.mock.calls[0][0].data.status).toBe("REVIEW"); expect(mocks.request).not.toHaveBeenCalled();
  });
  it("recovers interrupted requests as uncertain, not automatically pending again", async () => {
    await advanceKeepaDiscovery();
    expect(mocks.items.updateMany).toHaveBeenCalledWith({ where: { status: "FETCHING" }, data: expect.objectContaining({ status: "UNKNOWN" }) });
    expect(mocks.lists.updateMany).toHaveBeenCalledWith({ where: { status: "FETCHING" }, data: expect.objectContaining({ status: "UNKNOWN" }) });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("waits for sufficient tokens for a 50-token list instead of repeating requests", async () => {
    state.tokensLeft = 5; mocks.lists.findFirst.mockImplementation(async ({ where }) => where.status === "QUEUED" ? { categoryId: "123" } : null);
    await advanceKeepaDiscovery(); expect(mocks.request).not.toHaveBeenCalled(); expect(state.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 170000);
  });
  it("does not spend beyond the daily budget", async () => {
    state.spentTokens = 980; mocks.lists.findFirst.mockImplementation(async ({ where }) => where.status === "QUEUED" ? { categoryId: "123" } : null);
    await advanceKeepaDiscovery(); expect(mocks.request).not.toHaveBeenCalled(); expect(state.nextRunAt!.getUTCHours()).toBe(0);
  });
  it("shrinks a detail batch to the remaining daily budget", async () => {
    state.spentTokens = 999; mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a), item(b), item(c)] : []);
    await advanceKeepaDiscovery(); expect(mocks.request.mock.calls[0][1].asin).toBe(a);
  });
  it("honors a pause requested before reserving paid work", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a)] : []);
    mocks.catalog.findMany.mockImplementation(async () => { state.enabled = false; return []; });
    await advanceKeepaDiscovery(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it("backs off on HTTP 429 and refunds an unconsumed reservation", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a)] : []);
    mocks.request.mockResolvedValue({ status: 429, body: { tokensLeft: 0, refillRate: 20, refillIn: 500 } });
    await advanceKeepaDiscovery(); expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(state.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 59000);
    expect(mocks.state.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ spentTokens: { increment: -1 }, totalTokens: { increment: -1 } }) }));
    expect(mocks.items.update).toHaveBeenCalledWith({ where: { asin: a }, data: { status: "PENDING", error: null } });
  });
  it("does not retry or leak a secret-bearing network error", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a)] : []);
    mocks.request.mockRejectedValue(new Error("failed https://api.keepa.com/product?key=SECRET"));
    expect(await advanceKeepaDiscovery()).toBe("WAITING"); expect(mocks.request).toHaveBeenCalledTimes(1); expect(state.enabled).toBe(true);
    expect(state.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 299000);
    await advanceKeepaDiscovery(); expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.state.updateMany.mock.calls)).not.toContain("SECRET");
  });
  it("marks a missing provider product without resubmitting it", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a)] : []);
    mocks.request.mockResolvedValue({ status: 200, body: { tokensConsumed: 1, products: [] } });
    await advanceKeepaDiscovery(); expect(mocks.items.update.mock.calls[0][0].data.status).toBe("MISSING"); expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("loads root categories for one token and saves the cache", async () => {
    state.categoryStatus = "QUEUED"; mocks.request.mockResolvedValue({ status: 200, body: { tokensConsumed: 1, categories: { 123: { catId: 123, name: "Home" } } } });
    await advanceKeepaDiscovery(); expect(mocks.request).toHaveBeenCalledWith("category", { category: "0", parents: "0" });
    expect(state.categoryStatus).toBe("DONE"); expect(mocks.state.update.mock.calls.at(-1)?.[0].data.categoriesJson).toBe('[{"catId":"123","name":"Home"}]');
  });
  it("saves the entire paid bestseller response before local expansion", async () => {
    const body = { tokensConsumed: 50, tokensLeft: 50, bestSellersList: { domainId: 1, categoryId: 123, asinList: [a, b, c] } };
    mocks.lists.findFirst.mockImplementation(async ({ where }) => where.status === "QUEUED" ? { categoryId: "123" } : null);
    mocks.request.mockResolvedValue({ status: 200, body });
    await advanceKeepaDiscovery();
    expect(mocks.request).toHaveBeenCalledWith("bestsellers", { category: "123", range: "0", variations: "0" });
    expect(mocks.lists.update).toHaveBeenLastCalledWith({ where: { categoryId: "123" }, data: { status: "SAVED", responseJson: JSON.stringify(body), totalAsins: 3, fetchedAt: expect.any(Date), error: null } });
    expect(mocks.items.createMany).not.toHaveBeenCalled(); expect(mocks.catalog.createMany).not.toHaveBeenCalled();
  });
  it("starts product details without waiting for an enormous saved list to finish expanding", async () => {
    mocks.items.count.mockResolvedValue(1000);
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a)] : []);
    mocks.lists.findFirst.mockImplementation(async ({ where }) => where.status === "SAVED" ? { categoryId: "123", name: "Home", cursor: 1000, responseJson: "{}" } : null);
    await advanceKeepaDiscovery(); expect(mocks.request.mock.calls[0][0]).toBe("product");
    expect(mocks.items.createMany).not.toHaveBeenCalled();
  });
  it("holds rejected requests and stops instead of endlessly spending on retries", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a)] : []);
    mocks.request.mockResolvedValue({ status: 400, body: { tokensConsumed: 0 } });
    await advanceKeepaDiscovery(); expect(state.enabled).toBe(false);
    expect(mocks.items.update).toHaveBeenCalledWith({ where: { asin: a }, data: { status: "UNKNOWN", error: "Keepa HTTP 400; review before retry." } });
    await advanceKeepaDiscovery(); expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("retains a conservative spending reservation if saving the response fails", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a)] : []);
    mocks.items.update.mockRejectedValue(new Error("Database temporarily unavailable"));
    expect(await advanceKeepaDiscovery()).toBe("WAITING"); expect(state.enabled).toBe(true);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.items.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FETCHING", attemptedAt: expect.any(Date) } }));
  });
  it("continues other new ASINs after a temporary provider outage without retrying uncertain ones", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a)] : []);
    mocks.request.mockResolvedValue({ status: 503, body: { tokensConsumed: 0, tokensLeft: 100 } });
    expect(await advanceKeepaDiscovery()).toBe("WAITING"); expect(state.enabled).toBe(true);
    expect(mocks.items.update).toHaveBeenCalledWith({ where: { asin: a }, data: { status: "UNKNOWN", error: "Keepa HTTP 503; review before retry." } });
    await advanceKeepaDiscovery(); expect(mocks.request).toHaveBeenCalledTimes(1);
    state.nextRunAt = new Date(Date.now() - 1);
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(b)] : []);
    mocks.request.mockResolvedValue({ status: 200, body: { tokensConsumed: 1, tokensLeft: 99, products: [{ asin: b, domainId: 1, productType: 0, title: "Another product" }] } });
    expect(await advanceKeepaDiscovery()).toBe("PROGRESSED");
    expect(mocks.request).toHaveBeenCalledTimes(2); expect(mocks.request.mock.calls[1][1].asin).toBe(b);
  });
  it("does not undo an administrator's pause during a temporary failure", async () => {
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a)] : []);
    mocks.request.mockImplementation(async () => { state.enabled = false; throw new Error("Network interruption"); });
    await advanceKeepaDiscovery(); expect(state.enabled).toBe(false);
  });
  it("records an authenticated scheduler heartbeat without starting paid work", async () => {
    await recordKeepaSchedulerHeartbeat(); expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.state.upsert).toHaveBeenCalledWith({ where: { id: "main" }, create: { id: "main", lastSchedulerAt: expect.any(Date) }, update: { lastSchedulerAt: expect.any(Date) } });
  });
  it("automatically initializes discovery once at the first deployed scheduler tick", async () => {
    state.initializedAt = null; state.enabled = false; state.categoryStatus = "NONE";
    await recordKeepaSchedulerHeartbeat();
    expect(state.enabled).toBe(true); expect(state.categoryStatus).toBe("QUEUED");
    expect(state.autoQueueCategories).toBe(true); expect(state.initializedAt).toBeInstanceOf(Date);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("never overrides an administrator's later pause on subsequent ticks or deployments", async () => {
    state.enabled = false; await recordKeepaSchedulerHeartbeat();
    expect(state.enabled).toBe(false); expect(mocks.state.update).not.toHaveBeenCalled();
  });
  it("does not auto-start or mark initialized until a Keepa key is configured", async () => {
    vi.stubEnv("KEEPA_API_KEY", ""); state.initializedAt = null; state.enabled = false;
    await recordKeepaSchedulerHeartbeat(); expect(state.enabled).toBe(false); expect(state.initializedAt).toBeNull();
  });
  it("queues physical-product roots once from the cached category response without another API call", async () => {
    state.autoQueueCategories = true; state.categoryStatus = "DONE";
    state.categoriesJson = JSON.stringify([{ catId: "123", name: "Home" }, { catId: "456", name: "Kindle Store" }]);
    expect(await advanceKeepaDiscovery()).toBe("PROGRESSED");
    expect(mocks.lists.createMany).toHaveBeenCalledWith({ data: [{ categoryId: "123", name: "Home" }], skipDuplicates: true });
    expect(state.autoQueueCategories).toBe(false); expect(mocks.request).not.toHaveBeenCalled();
  });
  it("primes a newly fetched list before spending tokens on other queued category lists", async () => {
    mocks.lists.findFirst.mockImplementation(async ({ where }) => where.status === "QUEUED" ? { categoryId: "456" } : { categoryId: "123", name: "Home", cursor: 0, responseJson: JSON.stringify({ bestSellersList: { asinList: [a] } }) });
    expect(await advanceKeepaDiscovery()).toBe("PROGRESSED");
    expect(mocks.items.createMany).toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.lists.findFirst).toHaveBeenCalledWith({ where: { status: "SAVED", cursor: 0 }, orderBy: { updatedAt: "asc" } });
  });
  it("imports available product details before fetching another category", async () => {
    mocks.items.count.mockResolvedValue(1);
    mocks.items.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [item(a)] : []);
    mocks.lists.findFirst.mockResolvedValue({ categoryId: "456" });
    expect(await advanceKeepaDiscovery()).toBe("PROGRESSED");
    expect(mocks.request.mock.calls[0][0]).toBe("product");
  });
});

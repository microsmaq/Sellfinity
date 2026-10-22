import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ admin: vi.fn(), catalog: vi.fn(), products: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.admin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  adminArbitrageProduct: { findMany: mocks.catalog },
  product: { findMany: mocks.products },
} }));
import { prepareAdminLiveAmazonRefresh } from "@/lib/actions/admin-arbitrage";

const asin = (n: number) => `B${String(n).padStart(9, "0")}`;
function row(n: number, overrides = {}) {
  return { id: `row-${n}`, asin: asin(n), amazonUrl: `https://www.amazon.com/dp/${asin(n)}`,
    amazonInStock: true, amazonShippingVerified: true, amazonImportDetailsJson: "{}",
    amazonRefreshedAt: new Date("2026-01-01"), amazonCheckedAt: null, ...overrides };
}
const live = (n: number) => ({ supplierProductId: asin(n), sku: asin(n) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.admin.mockResolvedValue({ id: "admin" });
  mocks.products.mockResolvedValue([]);
  mocks.catalog.mockResolvedValue([]);
});

describe("admin live Amazon check priority (manual and scheduled)", () => {
  it("puts unverified live products first, other live products next, then the rest", async () => {
    mocks.catalog.mockResolvedValue([
      row(1, { amazonRefreshedAt: null }), // Never checked, but not live.
      row(2), // Verified live product.
      row(3, { amazonRefreshedAt: new Date(), amazonInStock: false, amazonShippingVerified: false, amazonImportDetailsJson: '{"availability":"UNKNOWN"}' }),
      row(4, { amazonRefreshedAt: null, amazonShippingVerified: false }),
      row(5, { amazonRefreshedAt: new Date() }), // Fresh verified live product is skipped.
    ]);
    mocks.products.mockResolvedValue([live(2), live(3), live(4), live(5), live(3)]);
    const result = await prepareAdminLiveAmazonRefresh(undefined, true);
    expect(result.requests.map((request) => request.requestKey)).toEqual([asin(4), asin(3), asin(2), asin(1)]);
    expect(result).toMatchObject({ skippedFresh: 1, publishedFirst: 3, awaitingVerification: 2 });
    expect(mocks.products.mock.calls[0][0].where).toMatchObject({ supplierName: "Amazon", listings: { some: { status: "ACTIVE", ebayListingId: { not: null } } } });
  });

  it("retries live unknown availability even if shipping is verified and the import is fresh", async () => {
    mocks.catalog.mockResolvedValue([row(1, { amazonRefreshedAt: new Date(), amazonInStock: false, amazonImportDetailsJson: '{"availability":"UNKNOWN"}' })]);
    mocks.products.mockResolvedValue([live(1)]);
    expect(await prepareAdminLiveAmazonRefresh()).toMatchObject({ requests: [{ requestKey: asin(1) }], skippedFresh: 0, awaitingVerification: 1 });
  });

  it("does not let a recent failed attempt jump ahead of never-checked live products", async () => {
    mocks.catalog.mockResolvedValue([
      row(1, { amazonShippingVerified: false, amazonCheckedAt: new Date() }),
      row(2, { amazonShippingVerified: false, amazonRefreshedAt: null }),
    ]);
    mocks.products.mockResolvedValue([live(1), live(2)]);
    expect((await prepareAdminLiveAmazonRefresh()).requests.map((r) => r.requestKey)).toEqual([asin(2), asin(1)]);
  });

  it("respects selected-only scope without adding unselected live products", async () => {
    mocks.catalog.mockResolvedValue([row(1)]);
    mocks.products.mockResolvedValue([live(2)]);
    const result = await prepareAdminLiveAmazonRefresh(["row-1", "row-1"], false);
    expect(mocks.catalog.mock.calls[0][0].where).toEqual({ status: { not: "ARCHIVED" }, id: { in: ["row-1"] } });
    expect(result.requests.map((r) => r.requestKey)).toEqual([asin(1)]);
    expect(result.publishedFirst).toBe(0);
  });

  it("uses one request for the same ASIN shared by several users and groups row IDs", async () => {
    mocks.catalog.mockResolvedValue([row(1), row(1, { id: "legacy-duplicate", asin: asin(1).toLowerCase() })]);
    mocks.products.mockResolvedValue([live(1), live(1)]);
    expect(await prepareAdminLiveAmazonRefresh(undefined, false)).toMatchObject({
      requests: [{ requestKey: asin(1), amazonUrl: `https://www.amazon.com/dp/${asin(1)}`, orderIds: ["row-1", "legacy-duplicate"] }], publishedFirst: 1,
    });
  });

  it("does not turn a confirmed unavailable item into pending verification just because shipping is unknown", async () => {
    mocks.catalog.mockResolvedValue([row(1, { amazonInStock: false, amazonShippingVerified: false, amazonRefreshedAt: new Date(), amazonImportDetailsJson: '{"availability":"UNAVAILABLE"}' })]);
    mocks.products.mockResolvedValue([live(1)]);
    expect(await prepareAdminLiveAmazonRefresh()).toMatchObject({ requests: [], skippedFresh: 1 });
  });

  it("requires admin access before reading products", async () => {
    mocks.admin.mockRejectedValue(new Error("Forbidden"));
    await expect(prepareAdminLiveAmazonRefresh()).rejects.toThrow("Forbidden");
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.products).not.toHaveBeenCalled();
  });
});

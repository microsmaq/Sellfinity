import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ connection: vi.fn(), draft: vi.fn(), source: vi.fn(), images: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { ebayConnection: { findUnique: mocks.connection }, listing: { findFirst: mocks.draft }, adminArbitrageProduct: { findUnique: mocks.source } } }));
vi.mock("@/lib/ebay", () => ({ getEbayClientForUser: mocks.client }));
vi.mock("@/lib/ebay/image-policy", () => ({ prepareEbayImages: mocks.images }));
import { publishListingForUser } from "@/lib/listings/publish";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.connection.mockResolvedValue({ status: "CONNECTED" });
  mocks.draft.mockResolvedValue({ product: { supplierName: "Amazon", supplierProductId: "B012345678" } });
  mocks.source.mockResolvedValue({ bannedAt: new Date() });
});
it.each([{}, { recoverSourceUnavailable: true }])("blocks a draft or recovery publication for a banned ASIN before image work or eBay calls: %j", async (options) => {
  expect(await publishListingForUser("owner", "listing", options)).toMatchObject({ ok: false, error: expect.stringContaining("banned by an administrator") });
  expect(mocks.images).not.toHaveBeenCalled(); expect(mocks.client).not.toHaveBeenCalled();
  expect(mocks.draft.mock.calls[0][0].where).toMatchObject({ id: "listing", userId: "owner" });
});

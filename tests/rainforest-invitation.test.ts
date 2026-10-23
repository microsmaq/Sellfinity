import { expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
import { mapRainforestProduct } from "@/lib/mirror/rainforest";

it.each([
  { type: "available_by_invitation" },
  { type: "invitation_only" },
  { type: "in_stock", raw: "Available by invitation only" },
  { raw: "Request an invite" },
])("records invitation-restricted provider offers as unavailable: %j", (availability) => {
  const product = mapRainforestProduct("B012345678", { title: "Item", buybox_winner: { price: { value: 49.99 }, availability } });
  expect(product).toMatchObject({ inStock: false, priceCents: 4999 });
});
it("retains confirmed invitation-only unavailability even when the provider omits a purchasable price", () => {
  expect(mapRainforestProduct("B012345678", { title: "Item", buybox_winner: { availability: { raw: "Available by invitation" } } })).toMatchObject({ inStock: false, priceCents: 0 });
});
it("keeps ordinary buyable invitation-card products available", () => {
  expect(mapRainforestProduct("B012345678", { title: "Birthday invitation cards", buybox_winner: { price: { value: 9.99 }, shipping: { value: 0 }, availability: { type: "in_stock", raw: "In stock" } } })).toMatchObject({ inStock: true });
});

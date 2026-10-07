import { expect, it } from "vitest";
import { catalogContentWarnings, requireCatalogContent } from "@/lib/arbitrage/catalog-content";
it("flags missing content including title-only placeholder descriptions", () => {
  expect(catalogContentWarnings({ amazonTitle: "Lamp", amazonDescription: "Lamp", amazonBulletPointsJson: "bad JSON", amazonImageUrlsJson: "[]" })).toEqual(["Description missing", "Feature bullets missing", "Product images missing"]);
});
it("allows substantive feature bullets when no separate description exists", () => {
  expect(() => requireCatalogContent({ amazonBulletPointsJson: '["Ceramic lamp with dimensions"]', amazonImageUrl: "https://m.media-amazon.com/image.jpg" })).not.toThrow();
});
it("holds publishing when images or both forms of product copy are absent", () => {
  expect(() => requireCatalogContent({ amazonDescription: "Details" })).toThrow("before publishing");
  expect(() => requireCatalogContent({ amazonImageUrl: "image" })).toThrow("before publishing");
});

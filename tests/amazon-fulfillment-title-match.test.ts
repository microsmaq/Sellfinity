import { describe, expect, it } from "vitest";
import { fulfillmentNamesMatch, fulfillmentTitleSimilarity } from "@/lib/amazon-email/title-match";

describe("Amazon delivery to eBay order title matching", () => {
  it("matches a concise eBay title to a longer Amazon delivery item name", () => {
    const score = fulfillmentTitleSimilarity(
      "Adjustable Aluminum Laptop Stand Ergonomic Riser",
      "Laptop Stand, Adjustable Aluminum Computer Riser Ergonomic Foldable Holder for Desk",
    );
    expect(score).toBeGreaterThanOrEqual(62);
  });

  it("handles common singular and plural wording differences", () => {
    const score = fulfillmentTitleSimilarity(
      "Magnetic Spice Rack Organizer 4 Tier",
      "Magnetic Spice Racks Organizers for Refrigerator, Four Tier Black",
    );
    expect(score).toBeGreaterThanOrEqual(62);
  });

  it("rejects products that only share one generic word", () => {
    const score = fulfillmentTitleSimilarity(
      "Adjustable Aluminum Laptop Stand",
      "Adjustable Stainless Steel Garden Hose Nozzle",
    );
    expect(score).toBe(0);
  });
});

describe("Amazon and eBay recipient matching", () => {
  it("allows middle initials and honorific differences", () => {
    expect(fulfillmentNamesMatch("Maria Santos", "Ms. Maria D. Santos")).toBe(true);
  });

  it("rejects different recipients", () => {
    expect(fulfillmentNamesMatch("Maria Santos", "John Peterson")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  assessProductMatch,
  assessProductMatchRules,
  isApprovedProductMatch,
} from "@/lib/arbitrage/product-match";

describe("arbitrage product identity", () => {
  it("approves the same product with reordered marketplace wording", () => {
    const result = assessProductMatchRules(
      "CIRCLE JOY Handheld Milk Frother Electric Whisk USB Rechargeable 3 Speed",
      "CIRCLE JOY Rechargeable Milk Frother Handheld Electric Whisk, 3 Speeds",
    );
    expect(result.verdict).toBe("LIKELY");
    expect(isApprovedProductMatch(result)).toBe(true);
  });

  it("rejects unrelated products despite a generic shared word", () => {
    const result = assessProductMatchRules(
      "Wireless Bluetooth Speaker Portable Waterproof Outdoor",
      "Wireless Charger Stand Fast Charging for iPhone",
    );
    expect(result.verdict).toBe("REJECTED");
    expect(isApprovedProductMatch(result)).toBe(false);
  });

  it("rejects conflicting models, quantities, and sizes", () => {
    expect(
      assessProductMatchRules("Sony WH1000XM5 Headphones", "Sony WH1000XM4 Headphones").reason,
    ).toMatch(/model/i);
    expect(
      assessProductMatchRules("Dog Treats 12 Pack Chicken", "Dog Treats 6 Pack Chicken").reason,
    ).toMatch(/quantit/i);
    expect(
      assessProductMatchRules("Ceramic Lamp 27 inch Blue", "Ceramic Lamp 18 inch Blue").reason,
    ).toMatch(/size|capacity/i);
  });

  it("fails safely to rules when no AI key is configured", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const result = await assessProductMatch(
      { title: "Adjustable Dumbbell Set 25lb Pair with Rack" },
      { title: "25lb Adjustable Dumbbell Pair and Storage Rack" },
    );
    process.env.OPENAI_API_KEY = previous;
    expect(result.method).toBe("RULES");
    expect(result.verdict).not.toBe("REJECTED");
  });
});

import { describe, expect, it } from "vitest";
import { buildHeroImagePrompt } from "@/lib/mirror/improve-main-image";

describe("AI listing hero image prompt", () => {
  it("prioritizes exact product truth and eBay image compliance", () => {
    const prompt = buildHeroImagePrompt({
      title: "Blue two-pack rechargeable lamps",
      category: "Home & Garden",
      bulletPoints: ["Two lamps included", "Blue finish", "USB rechargeable"],
    });

    expect(prompt).toContain("Two lamps included");
    expect(prompt).toContain("exact product identity");
    expect(prompt).toContain("pixel-faithful");
    expect(prompt).toContain("Absolutely no text");
    expect(prompt).toContain("pure white #FFFFFF background");
    expect(prompt).toContain("immediately and materially different");
    expect(prompt).toContain("at least three clearly visible creative improvements");
    expect(prompt).toContain("exactly the same product, quantity, variant, color, and accessories");
  });

  it("limits untrusted supplier detail text included in the prompt", () => {
    const prompt = buildHeroImagePrompt({
      title: "Product",
      category: "Category",
      bulletPoints: ["x".repeat(5_000)],
    });

    expect(prompt.length).toBeLessThan(5_500);
  });
});

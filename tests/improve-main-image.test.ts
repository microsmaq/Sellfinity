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
    expect(prompt).toContain("uploaded image is the source of truth");
    expect(prompt).toContain("Never modify shape, size, materials, colors, logos, branding");
    expect(prompt).toContain("Never keep the exact same angle");
    expect(prompt).toContain("pure white #FFFFFF background");
    expect(prompt).toContain("approximately 90% of the frame");
    expect(prompt).toContain("Would this image receive more clicks");
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

import { describe, expect, it } from "vitest";
import { buildHeroImagePrompt } from "@/lib/mirror/improve-main-image";

describe("AI listing hero image prompt", () => {
  it("requires a visibly distinct commercial reshoot while preserving product truth", () => {
    const prompt = buildHeroImagePrompt({
      title: "Blue two-pack rechargeable lamps",
      category: "Home & Garden",
      bulletPoints: ["Two lamps included", "Blue finish", "USB rechargeable"],
    });

    expect(prompt).toContain("Two lamps included");
    expect(prompt).toContain("COMPLETELY NEW premium studio photograph");
    expect(prompt).toContain("not an edited supplier image");
    expect(prompt).toContain("MANDATORY VISIBLE TRANSFORMATION");
    expect(prompt).toContain("ALL of these clearly visible changes");
    expect(prompt).toContain("uploaded image is the source of truth");
    expect(prompt).toContain("Preserve the exact product identity");
    expect(prompt).toContain("noticeably different but realistic camera viewpoint");
    expect(prompt).toContain("Do not return a near-copy");
    expect(prompt).toContain("pure white #FFFFFF background");
    expect(prompt).toContain("88-92% of the square frame");
    expect(prompt).toContain("substantially different, professionally reshot hero image");
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

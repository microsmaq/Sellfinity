import { describe, expect, it } from "vitest";
import { AMAZON_EMAIL_SEARCH_QUERY } from "@/lib/amazon-email/search-query";

describe("Amazon email search", () => {
  it("includes both US spellings of Amazon cancellation subjects", () => {
    expect(AMAZON_EMAIL_SEARCH_QUERY).toContain("canceled");
    expect(AMAZON_EMAIL_SEARCH_QUERY).toContain("cancelled");
    expect(AMAZON_EMAIL_SEARCH_QUERY).toContain("cancellation");
  });

  it("continues to include purchase and fulfillment updates", () => {
    expect(AMAZON_EMAIL_SEARCH_QUERY).toContain("ordered");
    expect(AMAZON_EMAIL_SEARCH_QUERY).toContain("shipped");
    expect(AMAZON_EMAIL_SEARCH_QUERY).toContain("delivered");
  });
});

import { describe, expect, it } from "vitest";
import { listingNeedsAttention } from "@/lib/listings/attention";

const assessment = (verdict: string) => ({ verdict });
const match = (profitCents: number, unavailable = false) => ({
  profitCents,
  unavailable,
});

describe("listingNeedsAttention", () => {
  it("includes unavailable, unprofitable, and uncertain source matches", () => {
    expect(
      listingNeedsAttention({ match: match(1000, true), sourceAssessment: assessment("MATCH") }),
    ).toBe(true);
    expect(
      listingNeedsAttention({ match: match(0), sourceAssessment: assessment("MATCH") }),
    ).toBe(true);
    expect(
      listingNeedsAttention({ match: null, sourceAssessment: assessment("REVIEW") }),
    ).toBe(true);
    expect(
      listingNeedsAttention({ match: null, sourceAssessment: assessment("REJECTED") }),
    ).toBe(true);
  });

  it("excludes healthy matches and listings that have not been matched yet", () => {
    expect(
      listingNeedsAttention({ match: match(1000), sourceAssessment: assessment("LIKELY") }),
    ).toBe(false);
    expect(
      listingNeedsAttention({ match: null, sourceAssessment: null }),
    ).toBe(false);
  });
});

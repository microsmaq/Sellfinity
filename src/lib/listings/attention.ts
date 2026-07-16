type AttentionListing = {
  match: {
    unavailable: boolean;
    profitCents: number;
  } | null;
  sourceAssessment: {
    verdict: string;
  } | null;
};

export function listingNeedsAttention(listing: AttentionListing): boolean {
  return Boolean(
    (listing.match &&
      (listing.match.unavailable || listing.match.profitCents <= 0)) ||
      (listing.sourceAssessment &&
        !["MATCH", "LIKELY"].includes(listing.sourceAssessment.verdict)),
  );
}

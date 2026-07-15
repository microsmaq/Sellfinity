export const AUTO_PUBLISH_MIN_MATCH_CONFIDENCE = 95;
export const AUTO_PUBLISH_MIN_MARGIN_PCT = 15;

export type AutoPublishCandidate = {
  matchVerdict: string;
  matchConfidence: number;
  marginPct: number;
  profitCents: number;
};

/** The shared safety gate used by the automatic batch query and its tests. */
export function isAutoPublishCandidate(item: AutoPublishCandidate): boolean {
  return (
    (item.matchVerdict === "MATCH" || item.matchVerdict === "LIKELY") &&
    item.matchConfidence >= AUTO_PUBLISH_MIN_MATCH_CONFIDENCE &&
    item.marginPct >= AUTO_PUBLISH_MIN_MARGIN_PCT &&
    item.profitCents > 0
  );
}

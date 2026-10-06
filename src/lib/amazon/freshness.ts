export const AMAZON_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Scheduled scans always reuse fresh data; manual scans honor the checkbox. */
export function shouldSkipRecentlyCheckedAmazon(scheduled: boolean, manualSkipFresh: boolean): boolean {
  return scheduled || manualSkipFresh;
}

export function isAmazonDataFresh(
  value: string | Date | null | undefined,
  now = Date.now(),
): boolean {
  if (!value) return false;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= now - AMAZON_FRESHNESS_WINDOW_MS;
}

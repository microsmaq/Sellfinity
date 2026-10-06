export const AMAZON_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Successful refreshes from other sources also count as a check. */
export function latestAmazonCheckAt(checkedAt: string | Date | null | undefined, refreshedAt: string | Date | null | undefined): Date | null {
  const values = [checkedAt, refreshedAt].map((value) => value instanceof Date ? value.getTime() : value ? Date.parse(value) : NaN).filter(Number.isFinite);
  return values.length ? new Date(Math.max(...values)) : null;
}

/** Scheduled scans always reuse fresh data; manual scans honor the checkbox. */
export function shouldSkipRecentlyCheckedAmazon(scheduled: boolean, manualSkipFresh: boolean): boolean {
  return scheduled || manualSkipFresh;
}

/** Never-checked/invalid timestamps first, then oldest checks. Preserve ties. */
export function oldestAmazonChecksFirst<T>(items: readonly T[], checkedAt: (item: T) => string | Date | null | undefined): T[] {
  return items.map((item, index) => {
    const value = checkedAt(item);
    const time = value instanceof Date ? value.getTime() : value ? Date.parse(value) : NaN;
    return { item, index, time: Number.isFinite(time) ? time : -Infinity };
  }).sort((a, b) => a.time - b.time || a.index - b.index).map(({ item }) => item);
}

export function isAmazonDataFresh(
  value: string | Date | null | undefined,
  now = Date.now(),
): boolean {
  if (!value) return false;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= now - AMAZON_FRESHNESS_WINDOW_MS;
}

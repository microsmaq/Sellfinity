const DAY_MS = 24 * 60 * 60 * 1000;

export type BestSellerSalesObservation = {
  capturedAt: number;
  quantitySold: number;
};

export function recentBestSellerSales(
  observations: BestSellerSalesObservation[],
  referenceAt: number,
  days: 7 | 30,
): number | null {
  const usable = observations
    .filter((item) => Number.isFinite(item.capturedAt) && item.capturedAt <= referenceAt && Number.isFinite(item.quantitySold))
    .sort((a, b) => a.capturedAt - b.capturedAt);
  if (usable.length < 2) return null;
  const latest = usable.at(-1)!;
  if (referenceAt - latest.capturedAt > 2 * DAY_MS) return null;
  const cutoff = referenceAt - days * DAY_MS;
  const tolerance = Math.max(2 * DAY_MS, days * DAY_MS * 0.25);
  let baseline = usable[0];
  for (const observation of usable) {
    if (Math.abs(observation.capturedAt - cutoff) < Math.abs(baseline.capturedAt - cutoff)) {
      baseline = observation;
    }
  }
  if (latest.capturedAt === baseline.capturedAt || Math.abs(baseline.capturedAt - cutoff) > tolerance) return null;
  if (latest.quantitySold < baseline.quantitySold) return null;
  return latest.quantitySold - baseline.quantitySold;
}

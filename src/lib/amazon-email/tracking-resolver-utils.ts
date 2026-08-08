export type ResolvedTracking = { trackingNumber: string; carrier: string | null };

function carrierForTracking(trackingNumber: string, content: string): string | null {
  if (/^1Z[0-9A-Z]{16}$/i.test(trackingNumber) || /\bUPS\b/i.test(content)) return "UPS";
  if (/^9\d{19,21}$/.test(trackingNumber) || /\bUSPS\b/i.test(content)) return "USPS";
  if (/^TBA\d{10,}$/i.test(trackingNumber) || /Amazon Logistics/i.test(content)) return "Amazon Logistics";
  if (/^\d{12,15}$/.test(trackingNumber) || /FedEx/i.test(content)) return "FedEx";
  return null;
}

export function trackingFromPage(url: string, html: string): ResolvedTracking | null {
  const decoded = `${url}\n${html}`.replace(/&amp;/gi, "&").replace(/%2F/gi, "/").replace(/%3A/gi, ":");
  const queryCandidates: string[] = [];
  try {
    const parsed = new URL(url);
    for (const key of ["tracking", "trackingNumber", "trackingId", "tracknum", "trknbr", "tLabels"]) {
      const value = parsed.searchParams.get(key);
      if (value) queryCandidates.push(value);
    }
  } catch { /* The URL was validated before fetching. */ }
  const patterns = [
    /\b1Z[0-9A-Z]{16}\b/i,
    /\b9\d{19,21}\b/,
    /\bTBA\d{10,}\b/i,
    /(?:tracking(?: number| #)?|tracking id)\s*[:#]?\s*([0-9]{12,15})\b/i,
  ];
  for (const candidate of [...queryCandidates, decoded]) {
    for (const pattern of patterns) {
      const match = candidate.match(pattern);
      const trackingNumber = (match?.[1] ?? match?.[0])?.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      if (trackingNumber) return { trackingNumber, carrier: carrierForTracking(trackingNumber, decoded) };
    }
  }
  return null;
}

globalThis.sellfinityTrackingFromPage = function trackingFromPage(url, content) {
  const decoded = `${url}\n${content}`
    .replace(/&amp;/gi, "&")
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":");
  const candidates = [];
  try {
    const parsed = new URL(url);
    for (const key of ["tracking", "trackingNumber", "trackingId", "tracknum", "trknbr", "tLabels"]) {
      const value = parsed.searchParams.get(key);
      if (value) candidates.push(value);
    }
  } catch {
    // The visible page URL is expected to be valid.
  }

  const patterns = [
    { regex: /\b1Z[0-9A-Z]{16}\b/i, carrier: "UPS" },
    { regex: /\b9\d{19,21}\b/, carrier: "USPS" },
    { regex: /\bTBA\d{10,}\b/i, carrier: "Amazon Logistics" },
    { regex: /(?:tracking(?: number| #)?|tracking id|track(?:ing)? #)\s*[:#]?\s*([0-9]{12,15})\b/i, carrier: "FedEx" }
  ];
  for (const candidate of [...candidates, decoded]) {
    for (const pattern of patterns) {
      const match = candidate.match(pattern.regex);
      const trackingNumber = (match?.[1] || match?.[0])?.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      if (trackingNumber) return { trackingNumber, carrier: pattern.carrier };
    }
  }
  return null;
};

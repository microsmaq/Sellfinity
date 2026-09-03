export function ebayLegacyItemIdFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{9,15}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "ebay.com" && !url.hostname.endsWith(".ebay.com")) return null;
    return url.pathname.match(/\/itm\/(?:[^/]+\/)?(\d{9,15})(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

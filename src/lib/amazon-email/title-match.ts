const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "new", "your", "you", "our", "this",
  "that", "item", "product", "free", "shipping", "amazon", "ebay",
]);

function singularize(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function fulfillmentTitleTokens(value: string): string[] {
  return [...new Set(value
    .toLowerCase()
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map(singularize)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token)))];
}

/**
 * Compare the actual eBay order title with the item name in an Amazon order or
 * delivery email. The containment component lets a concise eBay title match a
 * longer Amazon name, while the Dice component prevents a few generic shared
 * words from producing a confident match.
 */
export function fulfillmentTitleSimilarity(ebayTitle: string, amazonTitle: string): number {
  const ebay = fulfillmentTitleTokens(ebayTitle);
  const amazon = fulfillmentTitleTokens(amazonTitle);
  if (!ebay.length || !amazon.length) return 0;

  const amazonSet = new Set(amazon);
  const overlap = ebay.filter((token) => amazonSet.has(token)).length;
  if (overlap < 2) return 0;

  const shorter = Math.min(ebay.length, amazon.length);
  const containment = overlap / shorter;
  const dice = (2 * overlap) / (ebay.length + amazon.length);
  return Math.round((containment * 0.65 + dice * 0.35) * 100);
}

function nameTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !["mr", "mrs", "ms", "miss", "dr", "jr", "sr", "ii", "iii"].includes(token));
}

/** Names are compatible when the full shorter name is contained in the other,
 * allowing middle initials and common honorific differences. */
export function fulfillmentNamesMatch(ebayRecipient: string, amazonRecipient: string): boolean {
  const ebay = nameTokens(ebayRecipient);
  const amazon = new Set(nameTokens(amazonRecipient));
  if (!ebay.length || !amazon.size) return false;
  return ebay.every((token) => amazon.has(token))
    || [...amazon].every((token) => new Set(ebay).has(token));
}

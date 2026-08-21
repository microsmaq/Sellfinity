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

export type FulfillmentIdentityEvidence = {
  compatible: boolean;
  strength: number;
  addressMatches: boolean;
  recipientMatches: boolean;
};

export function fulfillmentMatchIsAmbiguous(
  selected: { score: number; identityStrength: number },
  candidates: Array<{ score: number; identityStrength: number }>,
): boolean {
  return selected.identityStrength === 0 && candidates.filter((candidate) =>
    candidate.identityStrength === selected.identityStrength && candidate.score === selected.score
  ).length > 1;
}

/**
 * Amazon confirmations can expose the account holder instead of the
 * dropship recipient. A unique, nearby purchase with strong product identity
 * may override that recipient-only conflict. A known address conflict never
 * qualifies, and the caller still applies duplicate-candidate protection.
 */
export function fulfillmentProductFallbackAllowed(input: {
  exactAsin: boolean;
  titleScore: number;
  purchaseDate?: Date | null;
  saleDate: Date;
  ebayAddressFingerprint?: string | null;
  amazonAddressFingerprint?: string | null;
}): boolean {
  if (!input.exactAsin && input.titleScore < 85) return false;
  if (!input.purchaseDate) return false;
  const distance = input.purchaseDate.getTime() - input.saleDate.getTime();
  if (distance < -3 * 86_400_000 || distance > 14 * 86_400_000) return false;
  return !(
    input.ebayAddressFingerprint
    && input.amazonAddressFingerprint
    && input.ebayAddressFingerprint !== input.amazonAddressFingerprint
  );
}

/** Cancellation templates sometimes name the Amazon account holder instead
 * of the dropship recipient. An exact ASIN close to the eBay sale is enough to
 * safely recover that cancellation even when the displayed names conflict. */
export function cancellationMatchOverridesIdentity(input: {
  purchaseStatus: string;
  exactAsin: boolean;
  purchaseDate?: Date | null;
  saleDate: Date;
}): boolean {
  if (input.purchaseStatus !== "CANCELLED" || !input.exactAsin || !input.purchaseDate) return false;
  const distance = input.purchaseDate.getTime() - input.saleDate.getTime();
  return distance >= -3 * 86_400_000 && distance <= 30 * 86_400_000;
}

/**
 * Delivery identity outranks product identity when repeated ASINs exist:
 * address match (2) > recipient-only match (1) > unavailable identity (0).
 * Known conflicts fail closed, except that an exact address may legitimately
 * use another member of the same household as the named recipient.
 */
export function fulfillmentIdentityEvidence(input: {
  ebayRecipientName?: string | null;
  amazonRecipientName?: string | null;
  ebayAddressFingerprint?: string | null;
  amazonAddressFingerprint?: string | null;
}): FulfillmentIdentityEvidence {
  const hasBothAddresses = !!input.ebayAddressFingerprint && !!input.amazonAddressFingerprint;
  const addressMatches = hasBothAddresses
    ? input.ebayAddressFingerprint === input.amazonAddressFingerprint
    : false;
  const hasBothNames = !!input.ebayRecipientName && !!input.amazonRecipientName;
  const recipientMatches = hasBothNames
    ? fulfillmentNamesMatch(input.ebayRecipientName!, input.amazonRecipientName!)
    : false;

  const compatible = !(hasBothAddresses && !addressMatches)
    && !(hasBothNames && !recipientMatches && !addressMatches);
  return {
    compatible,
    strength: (addressMatches ? 2 : 0) + (recipientMatches ? 1 : 0),
    addressMatches,
    recipientMatches,
  };
}

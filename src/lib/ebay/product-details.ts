export const EBAY_US_IDENTIFIER_UNAVAILABLE = "Does not apply";

const EPA_REGISTRATION_ASPECT = /\bEPA\b.*\b(?:registration|reg(?:istration)?)\b/i;
const EPA_REGISTRATION_VALUE = /\bEPA\s*(?:registration|reg\.?)\s*(?:number|no\.?)?\s*[:#-]?\s*(\d{1,7}-\d{1,7}(?:-\d{1,7})?)\b/i;
const PESTICIDE_CLAIM = /\b(?:pesticide|insecticide|herbicide|fungicide|rodenticide|algaecide|weed\s*killer|bug\s*killer|insect\s*repellent|flea\s*(?:and|&)\s*tick|disinfect(?:ant|s|ing)?|sanitiz(?:e|er|es|ing)|pool\s*shock|water\s*purif(?:ier|ication))\b/i;

function cleanEbayIdentifier(value?: string | null): string {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Preserve a marketplace brand when one is known; use eBay's conventional
 * fallback only for genuinely missing source data. */
export function ebayProductBrand(brand?: string | null): string {
  const value = cleanEbayIdentifier(brand);
  return value && !/^(?:unknown|n\/?a|not applicable|does not apply)$/i.test(value)
    ? value.slice(0, 65)
    : "Unbranded";
}

/** eBay validates MPN as a dedicated product identifier in addition to the
 * category's item specifics. Amazon does not reliably expose a manufacturer
 * part number, so use eBay US's supported unavailable-identifier value. */
export function ebayProductMpn(mpn?: string | null): string {
  const value = cleanEbayIdentifier(mpn);
  return value && !/^(?:unknown|n\/?a|not applicable|does not apply)$/i.test(value)
    ? value.slice(0, 65)
    : EBAY_US_IDENTIFIER_UNAVAILABLE;
}

export function requiredEbayAspectValue(
  aspectName: string,
  brand?: string | null,
  listingText?: string | null,
): string | null {
  if (aspectName.trim().toLowerCase() === "brand") return ebayProductBrand(brand);
  if (EPA_REGISTRATION_ASPECT.test(aspectName)) return extractEpaRegistrationNumber(listingText);
  return EBAY_US_IDENTIFIER_UNAVAILABLE;
}

export function extractEpaRegistrationNumber(value?: string | null): string | null {
  return cleanEbayIdentifier(value).match(EPA_REGISTRATION_VALUE)?.[1] ?? null;
}

export function hasPesticideClaims(value?: string | null): boolean {
  return PESTICIDE_CLAIM.test(cleanEbayIdentifier(value));
}

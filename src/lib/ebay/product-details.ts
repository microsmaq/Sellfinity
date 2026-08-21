export const EBAY_US_IDENTIFIER_UNAVAILABLE = "Does not apply";

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
): string {
  return aspectName.trim().toLowerCase() === "brand"
    ? ebayProductBrand(brand)
    : EBAY_US_IDENTIFIER_UNAVAILABLE;
}

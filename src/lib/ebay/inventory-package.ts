const EBAY_WEIGHT_UNITS = new Set(["POUND", "KILOGRAM", "OUNCE", "GRAM"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * eBay can return legacy package data that its current Inventory API will no
 * longer accept on the next PUT. Keep valid package metadata, but do not echo
 * a malformed/zero weight back and cause an otherwise unrelated sync to fail.
 */
export function sanitizeEbayPackageWeightAndSize(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;

  const sanitized = { ...value };
  const weight = sanitized.weight;

  if (weight !== undefined) {
    if (!isRecord(weight)) {
      delete sanitized.weight;
    } else {
      const numericValue = typeof weight.value === "number"
        ? weight.value
        : typeof weight.value === "string" && weight.value.trim() !== ""
          ? Number(weight.value)
          : Number.NaN;
      const unit = typeof weight.unit === "string" ? weight.unit.toUpperCase() : "";

      if (!Number.isFinite(numericValue) || numericValue <= 0 || !EBAY_WEIGHT_UNITS.has(unit)) {
        delete sanitized.weight;
      } else {
        sanitized.weight = { ...weight, unit };
      }
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

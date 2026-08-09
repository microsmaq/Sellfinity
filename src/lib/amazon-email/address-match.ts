import { createHash } from "node:crypto";

function normalizedAddressPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(street)\b/g, "st")
    .replace(/\b(avenue)\b/g, "ave")
    .replace(/\b(road)\b/g, "rd")
    .replace(/\b(boulevard)\b/g, "blvd")
    .replace(/\b(apartment|suite|unit)\b/g, "apt")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** Stable one-way value used for cross-platform delivery-address comparison.
 * The underlying customer address is deliberately not retained here. */
export function deliveryAddressFingerprint(addressLine1?: string | null, postalCode?: string | null): string | null {
  const street = normalizedAddressPart(addressLine1 ?? "");
  const normalizedPostal = normalizedAddressPart(postalCode ?? "");
  const postal = /^\d{9}$/.test(normalizedPostal) ? normalizedPostal.slice(0, 5) : normalizedPostal;
  if (!street || !postal) return null;
  return createHash("sha256").update(`${street}|${postal}`).digest("hex");
}

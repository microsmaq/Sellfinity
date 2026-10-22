/** Unknown imported availability is not evidence that a source is sold out. */
export function amazonSourceVerification(row: {
  amazonInStock: boolean;
  amazonShippingVerified?: boolean;
  amazonImportDetailsJson?: string;
}) {
  let availability: unknown;
  try { availability = JSON.parse(row.amazonImportDetailsJson || "{}").availability; }
  catch { /* Older snapshots may not contain valid import metadata. */ }
  const availabilityUnverified = availability === "UNKNOWN";
  const shippingUnverified = row.amazonShippingVerified === false;
  return {
    availabilityUnverified,
    shippingUnverified,
    needsVerification: availabilityUnverified || (row.amazonInStock && shippingUnverified),
  };
}

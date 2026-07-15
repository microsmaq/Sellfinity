-- Existing product-level matches predate child-variant verification. Reset
-- them so the resumable verification workflows replace prices with the exact
-- promoted child ASIN or reject the row when the variant is ambiguous.
UPDATE "Listing"
SET
  "sourceMatchVerdict" = 'UNVERIFIED',
  "sourceMatchConfidence" = NULL,
  "sourceMatchReason" = NULL,
  "sourceMatchMethod" = NULL,
  "sourceMatchCheckedAt" = NULL
WHERE "status" = 'ACTIVE' AND "ebayListingId" IS NOT NULL;

UPDATE "ArbitrageItem"
SET
  "matchVerdict" = 'UNVERIFIED',
  "matchConfidence" = 0,
  "matchReason" = NULL,
  "matchMethod" = 'RULES',
  "matchCheckedAt" = NULL;

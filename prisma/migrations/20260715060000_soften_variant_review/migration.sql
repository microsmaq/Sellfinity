-- Exact-variant verification originally treated every unresolved Amazon child
-- as a definite mismatch. Preserve those plausible candidates for seller
-- review instead; their stored prices remain non-actionable in the UI.
UPDATE "ArbitrageItem"
SET
  "matchVerdict" = 'REVIEW',
  "matchConfidence" = LEAST("matchConfidence", 50),
  "matchReason" = 'Candidate appears similar, but the exact Amazon child variant and live price are not proven. Review the eBay and Amazon links before using it.',
  "matchMethod" = 'RULES'
WHERE
  "matchVerdict" = 'REJECTED'
  AND "matchReason" = 'The exact Amazon child variant and its live price could not be proven.';

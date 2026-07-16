ALTER TABLE "Listing"
ADD COLUMN "endedReason" TEXT;

-- The first source-health implementation ended a listing while its claimed
-- work state was PROCESSING. Preserve those prior automatic removals as
-- recovery candidates without opting manually-ended listings into relisting.
UPDATE "Listing"
SET "endedReason" = 'SOURCE_UNAVAILABLE'
WHERE "status" = 'ENDED'
  AND "sourceMatchVerdict" = 'PROCESSING';

CREATE INDEX "Listing_userId_status_endedReason_idx"
ON "Listing"("userId", "status", "endedReason");

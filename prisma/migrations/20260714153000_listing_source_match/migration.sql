ALTER TABLE "Listing"
ADD COLUMN "sourceMatchVerdict" TEXT NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN "sourceMatchConfidence" INTEGER,
ADD COLUMN "sourceMatchReason" TEXT,
ADD COLUMN "sourceMatchMethod" TEXT,
ADD COLUMN "sourceMatchCheckedAt" TIMESTAMP(3);

CREATE INDEX "Listing_userId_status_sourceMatchVerdict_idx"
ON "Listing"("userId", "status", "sourceMatchVerdict");

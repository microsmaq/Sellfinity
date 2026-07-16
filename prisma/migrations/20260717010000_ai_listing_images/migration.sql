-- Persist the seller's opt-in choice and each item's image-edit outcome.
ALTER TABLE "MirrorBatch"
ADD COLUMN "improveMainImage" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "MirrorBatchItem"
ADD COLUMN "imageImprovementStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
ADD COLUMN "imageImprovementError" TEXT;

-- GPT Image returns base64 image data. Store the decoded JPEG so the public
-- eBay image importer receives a stable HTTPS URL rather than an expiring URL.
CREATE TABLE "GeneratedListingImage" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL DEFAULT 'image/jpeg',
  "data" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeneratedListingImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GeneratedListingImage_userId_createdAt_idx"
ON "GeneratedListingImage"("userId", "createdAt");

ALTER TABLE "GeneratedListingImage"
ADD CONSTRAINT "GeneratedListingImage_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

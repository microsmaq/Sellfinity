ALTER TABLE "User"
ADD COLUMN "improveListingContent" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "MirrorBatch"
ADD COLUMN "improveListingContent" BOOLEAN NOT NULL DEFAULT false;

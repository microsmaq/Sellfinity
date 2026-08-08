ALTER TABLE "AmazonPurchase"
  ADD COLUMN "trackingUrl" TEXT,
  ADD COLUMN "trackingResolvedAt" TIMESTAMP(3),
  ADD COLUMN "trackingLookupError" TEXT,
  ADD COLUMN "trackingAsinsJson" TEXT NOT NULL DEFAULT '[]';

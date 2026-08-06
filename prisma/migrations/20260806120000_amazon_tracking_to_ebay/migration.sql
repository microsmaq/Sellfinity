ALTER TABLE "AmazonEmailConnection" ADD COLUMN "autoUploadTracking" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Order"
  ADD COLUMN "ebayTrackingNumber" TEXT,
  ADD COLUMN "ebayTrackingCarrier" TEXT,
  ADD COLUMN "ebayTrackingSyncedAt" TIMESTAMP(3),
  ADD COLUMN "ebayTrackingSyncError" TEXT;

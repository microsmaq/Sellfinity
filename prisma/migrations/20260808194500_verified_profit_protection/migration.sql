ALTER TABLE "User"
  ADD COLUMN "autoProtectVerifiedProfit" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Order"
  ADD COLUMN "profitProtectionStatus" TEXT,
  ADD COLUMN "profitProtectionReviewedAt" TIMESTAMP(3),
  ADD COLUMN "profitProtectionOldPriceCents" INTEGER,
  ADD COLUMN "profitProtectionNewPriceCents" INTEGER,
  ADD COLUMN "profitProtectionError" TEXT;

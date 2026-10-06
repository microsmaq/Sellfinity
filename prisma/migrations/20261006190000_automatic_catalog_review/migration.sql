CREATE TABLE "AdminCatalogReviewAutomation" (
  "id" TEXT NOT NULL DEFAULT 'main',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "dailyLimit" INTEGER NOT NULL DEFAULT 10,
  "lockUntil" TIMESTAMP(3),
  "lastRunAt" TIMESTAMP(3),
  "lastSummaryJson" TEXT NOT NULL DEFAULT '{}',
  CONSTRAINT "AdminCatalogReviewAutomation_pkey" PRIMARY KEY ("id")
);

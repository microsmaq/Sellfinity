CREATE TABLE "KeepaDiscoveryState" (
  "id" TEXT NOT NULL DEFAULT 'main', "enabled" BOOLEAN NOT NULL DEFAULT false,
  "dailyTokenBudget" INTEGER NOT NULL DEFAULT 28800, "budgetDay" TEXT NOT NULL DEFAULT '',
  "spentTokens" INTEGER NOT NULL DEFAULT 0, "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "tokensLeft" INTEGER, "tokenSampleAt" TIMESTAMP(3), "refillRate" INTEGER NOT NULL DEFAULT 20,
  "nextRunAt" TIMESTAMP(3), "lockOwner" TEXT, "lockUntil" TIMESTAMP(3),
  "categoriesJson" TEXT NOT NULL DEFAULT '[]', "categoryStatus" TEXT NOT NULL DEFAULT 'NONE',
  "message" TEXT NOT NULL DEFAULT '', "lastSchedulerAt" TIMESTAMP(3), "initializedAt" TIMESTAMP(3),
  "autoQueueCategories" BOOLEAN NOT NULL DEFAULT true, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KeepaDiscoveryState_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "KeepaBestsellerList" (
  "categoryId" TEXT NOT NULL, "name" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "responseJson" TEXT, "cursor" INTEGER NOT NULL DEFAULT 0, "totalAsins" INTEGER NOT NULL DEFAULT 0,
  "queuedCount" INTEGER NOT NULL DEFAULT 0, "existingCount" INTEGER NOT NULL DEFAULT 0,
  "duplicateCount" INTEGER NOT NULL DEFAULT 0, "error" TEXT, "attemptedAt" TIMESTAMP(3),
  "fetchedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KeepaBestsellerList_pkey" PRIMARY KEY ("categoryId")
);
CREATE TABLE "KeepaDiscoveryItem" (
  "asin" TEXT NOT NULL, "categoryId" TEXT NOT NULL, "categoryName" TEXT NOT NULL,
  "bestsellerRank" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING',
  "responseJson" TEXT, "error" TEXT, "attemptedAt" TIMESTAMP(3), "fetchedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KeepaDiscoveryItem_pkey" PRIMARY KEY ("asin")
);
CREATE INDEX "KeepaBestsellerList_status_createdAt_idx" ON "KeepaBestsellerList"("status", "createdAt");
CREATE INDEX "KeepaDiscoveryItem_status_createdAt_asin_idx" ON "KeepaDiscoveryItem"("status", "createdAt", "asin");
CREATE INDEX "KeepaDiscoveryItem_status_updatedAt_idx" ON "KeepaDiscoveryItem"("status", "updatedAt");

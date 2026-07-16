CREATE TABLE "RainforestCache" (
  "cacheKey" TEXT NOT NULL,
  "requestType" TEXT NOT NULL,
  "responseJson" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lockedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RainforestCache_pkey" PRIMARY KEY ("cacheKey")
);

CREATE INDEX "RainforestCache_expiresAt_idx" ON "RainforestCache"("expiresAt");
CREATE INDEX "RainforestCache_requestType_expiresAt_idx" ON "RainforestCache"("requestType", "expiresAt");

CREATE TABLE "RainforestUsageDaily" (
  "id" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "workflow" TEXT NOT NULL,
  "requestType" TEXT NOT NULL,
  "providerRequests" INTEGER NOT NULL DEFAULT 0,
  "cacheHits" INTEGER NOT NULL DEFAULT 0,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "budgetBlocks" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RainforestUsageDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RainforestUsageDaily_day_workflow_requestType_key"
ON "RainforestUsageDaily"("day", "workflow", "requestType");
CREATE INDEX "RainforestUsageDaily_day_idx" ON "RainforestUsageDaily"("day");

CREATE TABLE "ArbitrageCandidateAttempt" (
  "ebayItemId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "retryAfter" TIMESTAMP(3) NOT NULL,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ArbitrageCandidateAttempt_pkey" PRIMARY KEY ("ebayItemId")
);

CREATE INDEX "ArbitrageCandidateAttempt_retryAfter_idx"
ON "ArbitrageCandidateAttempt"("retryAfter");

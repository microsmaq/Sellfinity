CREATE TABLE "MirrorBatch" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "totalCount" INTEGER NOT NULL,
  "succeededCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "MirrorBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MirrorBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "MirrorBatchItem" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "inputUrl" TEXT NOT NULL,
  "sourceReferenceId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "title" TEXT,
  "sourcePriceCents" INTEGER,
  "listingPriceCents" INTEGER,
  "listingId" TEXT,
  "ebayListingId" TEXT,
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "MirrorBatchItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MirrorBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "MirrorBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MirrorBatch_userId_createdAt_idx" ON "MirrorBatch"("userId", "createdAt");
CREATE INDEX "MirrorBatch_userId_status_idx" ON "MirrorBatch"("userId", "status");
CREATE UNIQUE INDEX "MirrorBatchItem_batchId_position_key" ON "MirrorBatchItem"("batchId", "position");
CREATE INDEX "MirrorBatchItem_batchId_status_idx" ON "MirrorBatchItem"("batchId", "status");

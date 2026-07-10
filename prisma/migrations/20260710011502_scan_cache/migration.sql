-- CreateTable
CREATE TABLE "ScanCache" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScanCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScanCache_cacheKey_key" ON "ScanCache"("cacheKey");

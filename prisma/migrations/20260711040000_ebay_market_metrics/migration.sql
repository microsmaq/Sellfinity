CREATE TABLE "EbayMarketMetric" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ebayListingId" TEXT NOT NULL,
    "estimatedSales30d" INTEGER NOT NULL,
    "competitorCount" INTEGER NOT NULL,
    "averageCompetitorPriceCents" INTEGER NOT NULL,
    "query" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EbayMarketMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EbayMarketMetric_userId_ebayListingId_key"
ON "EbayMarketMetric"("userId", "ebayListingId");
CREATE INDEX "EbayMarketMetric_userId_idx" ON "EbayMarketMetric"("userId");
ALTER TABLE "EbayMarketMetric"
ADD CONSTRAINT "EbayMarketMetric_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArbitrageItem"
ADD COLUMN "competitorCount" INTEGER,
ADD COLUMN "avgCompPriceCents" INTEGER;

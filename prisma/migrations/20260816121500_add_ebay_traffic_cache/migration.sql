CREATE TABLE "EbayListingTrafficSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ebayListingId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "impressions" INTEGER,
    "views" INTEGER,
    "clickThroughRate" DOUBLE PRECISION,
    "salesConversionRate" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EbayListingTrafficSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EbayTrafficDailySnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "impressions" INTEGER NOT NULL,
    "views" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EbayTrafficDailySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EbayListingTrafficSnapshot_userId_ebayListingId_key" ON "EbayListingTrafficSnapshot"("userId", "ebayListingId");
CREATE INDEX "EbayListingTrafficSnapshot_userId_fetchedAt_idx" ON "EbayListingTrafficSnapshot"("userId", "fetchedAt");
CREATE UNIQUE INDEX "EbayTrafficDailySnapshot_userId_scopeKey_date_key" ON "EbayTrafficDailySnapshot"("userId", "scopeKey", "date");
CREATE INDEX "EbayTrafficDailySnapshot_userId_scopeKey_date_idx" ON "EbayTrafficDailySnapshot"("userId", "scopeKey", "date");

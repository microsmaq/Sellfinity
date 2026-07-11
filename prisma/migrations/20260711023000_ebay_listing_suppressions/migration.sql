CREATE TABLE "EbayListingSuppression" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ebayListingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EbayListingSuppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EbayListingSuppression_userId_ebayListingId_key"
ON "EbayListingSuppression"("userId", "ebayListingId");
CREATE INDEX "EbayListingSuppression_userId_idx"
ON "EbayListingSuppression"("userId");
ALTER TABLE "EbayListingSuppression"
ADD CONSTRAINT "EbayListingSuppression_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

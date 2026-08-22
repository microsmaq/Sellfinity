CREATE TABLE "EbayListingSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ebayListingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "imageUrl" TEXT,
    "quantity" INTEGER,
    "listingDate" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayListingSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EbayListingSnapshot_userId_ebayListingId_key"
ON "EbayListingSnapshot"("userId", "ebayListingId");

CREATE INDEX "EbayListingSnapshot_userId_lastSeenAt_idx"
ON "EbayListingSnapshot"("userId", "lastSeenAt");

ALTER TABLE "EbayListingSnapshot"
ADD CONSTRAINT "EbayListingSnapshot_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

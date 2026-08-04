-- CreateTable
CREATE TABLE "AmazonEmailConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'GOOGLE',
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "email" TEXT,
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "processedMessageIdsJson" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "AmazonEmailConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AmazonPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amazonOrderId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "purchasedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ORDERED',
    "subtotalCents" INTEGER,
    "shippingCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "expectedDeliveryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AmazonPurchase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AmazonPurchaseItem" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "asin" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER,
    "lineTotalCents" INTEGER,
    "allocatedShippingCents" INTEGER NOT NULL DEFAULT 0,
    "allocatedTaxCents" INTEGER NOT NULL DEFAULT 0,
    "allocatedDiscountCents" INTEGER NOT NULL DEFAULT 0,
    "amazonUrl" TEXT,
    "matchedOrderId" TEXT,
    "matchConfidence" INTEGER,
    "matchReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AmazonPurchaseItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Order" ADD COLUMN "sourcingStatus" TEXT NOT NULL DEFAULT 'NOT_PURCHASED';
ALTER TABLE "Order" ADD COLUMN "amazonMatchedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "AmazonEmailConnection_userId_key" ON "AmazonEmailConnection"("userId");
CREATE UNIQUE INDEX "AmazonPurchase_userId_amazonOrderId_key" ON "AmazonPurchase"("userId", "amazonOrderId");
CREATE UNIQUE INDEX "AmazonPurchase_userId_sourceMessageId_key" ON "AmazonPurchase"("userId", "sourceMessageId");
CREATE INDEX "AmazonPurchase_userId_purchasedAt_idx" ON "AmazonPurchase"("userId", "purchasedAt");
CREATE INDEX "AmazonPurchase_userId_status_idx" ON "AmazonPurchase"("userId", "status");
CREATE UNIQUE INDEX "AmazonPurchaseItem_matchedOrderId_key" ON "AmazonPurchaseItem"("matchedOrderId");
CREATE INDEX "AmazonPurchaseItem_purchaseId_idx" ON "AmazonPurchaseItem"("purchaseId");
CREATE INDEX "AmazonPurchaseItem_asin_idx" ON "AmazonPurchaseItem"("asin");

ALTER TABLE "AmazonEmailConnection" ADD CONSTRAINT "AmazonEmailConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AmazonPurchase" ADD CONSTRAINT "AmazonPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AmazonPurchaseItem" ADD CONSTRAINT "AmazonPurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "AmazonPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AmazonPurchaseItem" ADD CONSTRAINT "AmazonPurchaseItem_matchedOrderId_fkey" FOREIGN KEY ("matchedOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

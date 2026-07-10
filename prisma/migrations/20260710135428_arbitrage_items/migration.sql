-- CreateTable
CREATE TABLE "ArbitrageItem" (
    "id" TEXT NOT NULL,
    "ebayItemId" TEXT NOT NULL,
    "ebayTitle" TEXT NOT NULL,
    "ebayPriceCents" INTEGER NOT NULL,
    "ebayUrl" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "amazonTitle" TEXT NOT NULL,
    "amazonPriceCents" INTEGER NOT NULL,
    "amazonUrl" TEXT NOT NULL,
    "profitCents" INTEGER NOT NULL,
    "marginPct" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "salesEst" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArbitrageItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArbitrageItem_ebayItemId_key" ON "ArbitrageItem"("ebayItemId");

-- CreateIndex
CREATE INDEX "ArbitrageItem_profitCents_idx" ON "ArbitrageItem"("profitCents");

-- CreateIndex
CREATE INDEX "ArbitrageItem_category_idx" ON "ArbitrageItem"("category");

-- CreateIndex
CREATE INDEX "ArbitrageItem_createdAt_idx" ON "ArbitrageItem"("createdAt");

-- CreateIndex
CREATE INDEX "ArbitrageItem_asin_idx" ON "ArbitrageItem"("asin");

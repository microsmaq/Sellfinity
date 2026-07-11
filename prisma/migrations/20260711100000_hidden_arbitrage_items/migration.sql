CREATE TABLE "HiddenArbitrageItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ebayItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HiddenArbitrageItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HiddenArbitrageItem_userId_ebayItemId_key"
ON "HiddenArbitrageItem"("userId", "ebayItemId");
CREATE INDEX "HiddenArbitrageItem_userId_idx" ON "HiddenArbitrageItem"("userId");
CREATE INDEX "HiddenArbitrageItem_ebayItemId_idx" ON "HiddenArbitrageItem"("ebayItemId");
ALTER TABLE "HiddenArbitrageItem" ADD CONSTRAINT "HiddenArbitrageItem_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HiddenArbitrageItem" ADD CONSTRAINT "HiddenArbitrageItem_ebayItemId_fkey"
FOREIGN KEY ("ebayItemId") REFERENCES "ArbitrageItem"("ebayItemId") ON DELETE CASCADE ON UPDATE CASCADE;

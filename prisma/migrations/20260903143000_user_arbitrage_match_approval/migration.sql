CREATE TABLE "UserArbitrageMatchDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ebayItemId" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'APPROVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserArbitrageMatchDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserArbitrageMatchDecision_userId_ebayItemId_key"
ON "UserArbitrageMatchDecision"("userId", "ebayItemId");

CREATE INDEX "UserArbitrageMatchDecision_userId_decision_idx"
ON "UserArbitrageMatchDecision"("userId", "decision");

CREATE INDEX "UserArbitrageMatchDecision_ebayItemId_idx"
ON "UserArbitrageMatchDecision"("ebayItemId");

ALTER TABLE "UserArbitrageMatchDecision"
ADD CONSTRAINT "UserArbitrageMatchDecision_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserArbitrageMatchDecision"
ADD CONSTRAINT "UserArbitrageMatchDecision_ebayItemId_fkey"
FOREIGN KEY ("ebayItemId") REFERENCES "ArbitrageItem"("ebayItemId") ON DELETE CASCADE ON UPDATE CASCADE;

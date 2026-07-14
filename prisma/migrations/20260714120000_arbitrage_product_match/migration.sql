ALTER TABLE "ArbitrageItem"
ADD COLUMN "matchVerdict" TEXT NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN "matchConfidence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "matchReason" TEXT,
ADD COLUMN "matchMethod" TEXT NOT NULL DEFAULT 'RULES',
ADD COLUMN "matchCheckedAt" TIMESTAMP(3);

CREATE INDEX "ArbitrageItem_matchVerdict_matchConfidence_idx"
ON "ArbitrageItem"("matchVerdict", "matchConfidence");

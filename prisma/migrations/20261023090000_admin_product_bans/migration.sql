ALTER TABLE "AdminArbitrageProduct" ADD COLUMN "bannedAt" TIMESTAMP(3);
CREATE INDEX "AdminArbitrageProduct_bannedAt_idx" ON "AdminArbitrageProduct"("bannedAt");

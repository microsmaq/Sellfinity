ALTER TABLE "Product"
ADD COLUMN "amazonRefreshedAt" TIMESTAMP(3);

CREATE INDEX "Product_userId_amazonRefreshedAt_idx"
ON "Product"("userId", "amazonRefreshedAt");

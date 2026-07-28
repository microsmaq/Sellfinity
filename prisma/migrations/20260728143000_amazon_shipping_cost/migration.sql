ALTER TABLE "AdminArbitrageProduct"
ADD COLUMN "amazonShippingCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ArbitrageItem"
ADD COLUMN "amazonShippingCents" INTEGER NOT NULL DEFAULT 0;

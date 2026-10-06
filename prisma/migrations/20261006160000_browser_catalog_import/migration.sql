ALTER TABLE "AdminArbitrageProduct"
ADD COLUMN "amazonShippingVerified" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "amazonImportDetailsJson" TEXT NOT NULL DEFAULT '{}';

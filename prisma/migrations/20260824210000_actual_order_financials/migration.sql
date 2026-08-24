ALTER TABLE "EbayConnection"
  ADD COLUMN "oauthScopesJson" TEXT NOT NULL DEFAULT '[]';

ALTER TABLE "Order"
  ADD COLUMN "ebayCheckoutOrderId" TEXT,
  ADD COLUMN "ebayGrossAmountCents" INTEGER,
  ADD COLUMN "ebayOrderEarningsCents" INTEGER,
  ADD COLUMN "ebayTransactionFeeCents" INTEGER,
  ADD COLUMN "ebayAdvertisingFeeCents" INTEGER,
  ADD COLUMN "ebayOtherFeeCents" INTEGER,
  ADD COLUMN "ebayShippingLabelCents" INTEGER,
  ADD COLUMN "ebayRefundCents" INTEGER,
  ADD COLUMN "ebayFeeBreakdownJson" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "ebayFinancialsSource" TEXT NOT NULL DEFAULT 'ESTIMATED',
  ADD COLUMN "ebayFinancialsCheckedAt" TIMESTAMP(3),
  ADD COLUMN "ebayFinancialsUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "ebayFinancialsError" TEXT;

CREATE INDEX "Order_userId_ebayCheckoutOrderId_idx"
  ON "Order"("userId", "ebayCheckoutOrderId");

CREATE INDEX "Order_userId_ebayFinancialsSource_saleDate_idx"
  ON "Order"("userId", "ebayFinancialsSource", "saleDate");

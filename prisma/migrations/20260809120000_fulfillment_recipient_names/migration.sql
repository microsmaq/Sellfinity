ALTER TABLE "AmazonPurchase" ADD COLUMN "recipientName" TEXT;
ALTER TABLE "AmazonPurchase" ADD COLUMN "deliveryAddressFingerprint" TEXT;
ALTER TABLE "Order" ADD COLUMN "shippingRecipientName" TEXT;
ALTER TABLE "Order" ADD COLUMN "shippingAddressFingerprint" TEXT;

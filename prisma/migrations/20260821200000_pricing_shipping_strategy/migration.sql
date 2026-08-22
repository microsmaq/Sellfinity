ALTER TABLE "User"
ADD COLUMN "pricingStrategy" TEXT NOT NULL DEFAULT 'AI';

ALTER TABLE "Listing"
ADD COLUMN "shippingStrategy" TEXT NOT NULL DEFAULT 'FREE_SHIPPING',
ADD COLUMN "buyerShippingCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Listing"
ADD CONSTRAINT "Listing_buyerShippingCents_check"
CHECK ("buyerShippingCents" >= 0 AND "buyerShippingCents" <= 700);


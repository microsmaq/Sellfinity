ALTER TABLE "User"
ADD COLUMN "role" TEXT NOT NULL DEFAULT 'USER';

CREATE TABLE "AdminArbitrageProduct" (
    "id" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "amazonTitle" TEXT NOT NULL,
    "amazonPriceCents" INTEGER NOT NULL,
    "amazonUrl" TEXT NOT NULL,
    "amazonImageUrl" TEXT,
    "category" TEXT NOT NULL,
    "isAmazonBestSeller" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "ebayItemId" TEXT,
    "ebayTitle" TEXT,
    "ebayPriceCents" INTEGER,
    "ebayUrl" TEXT,
    "ebayImageUrl" TEXT,
    "matchVerdict" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "matchConfidence" INTEGER NOT NULL DEFAULT 0,
    "matchReason" TEXT,
    "estimatedSales30d" INTEGER,
    "competitorCount" INTEGER,
    "averageCompetitorPriceCents" INTEGER,
    "ebayRecommendedPriceCents" INTEGER,
    "suggestedPriceCents" INTEGER,
    "estimatedProfitCents" INTEGER,
    "marginPct" INTEGER,
    "lastResearchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminArbitrageProduct_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminArbitrageProduct_asin_key"
ON "AdminArbitrageProduct"("asin");

CREATE UNIQUE INDEX "AdminArbitrageProduct_ebayItemId_key"
ON "AdminArbitrageProduct"("ebayItemId");

CREATE INDEX "AdminArbitrageProduct_status_updatedAt_idx"
ON "AdminArbitrageProduct"("status", "updatedAt");

CREATE INDEX "AdminArbitrageProduct_category_idx"
ON "AdminArbitrageProduct"("category");

CREATE INDEX "AdminArbitrageProduct_matchConfidence_idx"
ON "AdminArbitrageProduct"("matchConfidence");

CREATE INDEX "AdminArbitrageProduct_marginPct_idx"
ON "AdminArbitrageProduct"("marginPct");

-- Preserve the current research database in the new Amazon-first catalog.
-- When several eBay candidates share an ASIN, retain the strongest match.
INSERT INTO "AdminArbitrageProduct" (
    "id",
    "asin",
    "amazonTitle",
    "amazonPriceCents",
    "amazonUrl",
    "category",
    "status",
    "ebayItemId",
    "ebayTitle",
    "ebayPriceCents",
    "ebayUrl",
    "ebayImageUrl",
    "matchVerdict",
    "matchConfidence",
    "matchReason",
    "estimatedSales30d",
    "competitorCount",
    "averageCompetitorPriceCents",
    "ebayRecommendedPriceCents",
    "suggestedPriceCents",
    "estimatedProfitCents",
    "marginPct",
    "lastResearchedAt",
    "createdAt",
    "updatedAt"
)
SELECT DISTINCT ON ("asin")
    'admin_' || md5(random()::text || clock_timestamp()::text || "asin"),
    "asin",
    "amazonTitle",
    "amazonPriceCents",
    "amazonUrl",
    "category",
    CASE WHEN "matchVerdict" IN ('MATCH', 'LIKELY', 'REVIEW') THEN 'PUBLISHED' ELSE 'NO_MATCH' END,
    "ebayItemId",
    "ebayTitle",
    "ebayPriceCents",
    "ebayUrl",
    "imageUrl",
    "matchVerdict",
    "matchConfidence",
    "matchReason",
    "salesEst",
    "competitorCount",
    "avgCompPriceCents",
    "bestSellingPriceCents",
    "ebayPriceCents",
    "profitCents",
    "marginPct",
    "matchCheckedAt",
    "createdAt",
    "updatedAt"
FROM "ArbitrageItem"
ORDER BY "asin", "matchConfidence" DESC, "profitCents" DESC, "updatedAt" DESC;

-- Dedicated owner account. Only the password hash is stored in source.
INSERT INTO "User" (
    "id",
    "email",
    "passwordHash",
    "name",
    "role",
    "plan",
    "createdAt"
)
VALUES (
    'sellfinity_primary_admin',
    'admin@sellfinity.app',
    '$2b$12$5IfAUMR2.BV5QrBsFo.Z.uEcYqnLrfUbq1CnvuqjFmUSF86JbiBvG',
    'Sellfinity Admin',
    'ADMIN',
    'SCALE',
    CURRENT_TIMESTAMP
)
ON CONFLICT ("email") DO UPDATE SET "role" = 'ADMIN';

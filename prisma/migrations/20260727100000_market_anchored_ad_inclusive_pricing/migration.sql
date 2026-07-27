-- Reprice the existing Amazon-first catalog with the same market-aware model
-- used by the application:
--   1. anchor to eBay's recommendation (or 97% of average competition),
--   2. prefer a 20% margin,
--   3. never cross below a 15% margin,
--   4. reserve 3% of revenue for Promoted Listings.
WITH floors AS (
  SELECT
    item."id",
    item."amazonPriceCents",
    item."averageCompetitorPriceCents",
    item."ebayRecommendedPriceCents",
    minimum."price" AS "minimumPrice",
    preferred."price" AS "preferredPrice"
  FROM "AdminArbitrageProduct" item
  CROSS JOIN LATERAL (
    SELECT MIN(candidate) AS "price"
    FROM generate_series(
      GREATEST(
        99,
        CEIL(
          (item."amazonPriceCents" + 30)::numeric /
          (1 - 0.1325 - 0.03 - 0.15)
        )::integer
      ),
      GREATEST(
        99,
        CEIL(
          (item."amazonPriceCents" + 30)::numeric /
          (1 - 0.1325 - 0.03 - 0.15)
        )::integer
      ) + 5
    ) candidate
    WHERE (
      candidate
      - ROUND(candidate * (0.1325 + 0.03))
      - 30
      - item."amazonPriceCents"
    )::numeric / candidate >= 0.15
  ) minimum
  CROSS JOIN LATERAL (
    SELECT MIN(candidate) AS "price"
    FROM generate_series(
      GREATEST(
        99,
        CEIL(
          (item."amazonPriceCents" + 30)::numeric /
          (1 - 0.1325 - 0.03 - 0.20)
        )::integer
      ),
      GREATEST(
        99,
        CEIL(
          (item."amazonPriceCents" + 30)::numeric /
          (1 - 0.1325 - 0.03 - 0.20)
        )::integer
      ) + 5
    ) candidate
    WHERE (
      candidate
      - ROUND(candidate * (0.1325 + 0.03))
      - 30
      - item."amazonPriceCents"
    )::numeric / candidate >= 0.20
  ) preferred
),
anchors AS (
  SELECT
    floors.*,
    CASE
      WHEN "ebayRecommendedPriceCents" IS NOT NULL
        AND "ebayRecommendedPriceCents" > 0
        THEN "ebayRecommendedPriceCents"
      WHEN "averageCompetitorPriceCents" IS NOT NULL
        AND "averageCompetitorPriceCents" > 0
        THEN ROUND("averageCompetitorPriceCents" * 0.97)
      ELSE "preferredPrice"
    END AS "anchorPrice"
  FROM floors
),
prices AS (
  SELECT
    *,
    CASE
      WHEN "averageCompetitorPriceCents" IS NULL
        OR "averageCompetitorPriceCents" <= 0
        THEN GREATEST("preferredPrice", "anchorPrice")
      WHEN "averageCompetitorPriceCents" >= "preferredPrice"
        THEN LEAST(
          "averageCompetitorPriceCents",
          GREATEST("preferredPrice", "anchorPrice")
        )
      WHEN "averageCompetitorPriceCents" >= "minimumPrice"
        THEN LEAST(
          "averageCompetitorPriceCents",
          GREATEST("minimumPrice", "anchorPrice")
        )
      ELSE "minimumPrice"
    END::integer AS "suggestedPrice"
  FROM anchors
),
projected AS (
  SELECT
    "id",
    "suggestedPrice",
    (
      "suggestedPrice"
      - ROUND("suggestedPrice" * 0.1325)
      - ROUND("suggestedPrice" * 0.03)
      - 30
      - "amazonPriceCents"
    )::integer AS "profit",
    ROUND(
      (
        "suggestedPrice"
        - ROUND("suggestedPrice" * 0.1325)
        - ROUND("suggestedPrice" * 0.03)
        - 30
        - "amazonPriceCents"
      )::numeric / "suggestedPrice" * 100
    )::integer AS "margin"
  FROM prices
)
UPDATE "AdminArbitrageProduct" item
SET
  "suggestedPriceCents" = projected."suggestedPrice",
  "estimatedProfitCents" = projected."profit",
  "marginPct" = projected."margin"
FROM projected
WHERE item."id" = projected."id";

-- Keep the existing seller-facing Arbitrage Finder snapshot aligned with the
-- canonical admin catalog. feeCents now includes final-value, fixed-order,
-- and the 3% projected advertising allowance.
UPDATE "ArbitrageItem" opportunity
SET
  "profitCents" = catalog."estimatedProfitCents",
  "marginPct" = catalog."marginPct",
  "feeCents" = (
    ROUND(catalog."suggestedPriceCents" * 0.1325)
    + ROUND(catalog."suggestedPriceCents" * 0.03)
    + 30
  )::integer
FROM "AdminArbitrageProduct" catalog
WHERE
  catalog."status" = 'PUBLISHED'
  AND catalog."ebayItemId" = opportunity."ebayItemId"
  AND catalog."suggestedPriceCents" IS NOT NULL;

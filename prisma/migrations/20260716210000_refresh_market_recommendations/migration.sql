-- Cached values from the earlier broad-query model can contain unrelated
-- low-price accessories. Rebuild them on the next full market refresh using
-- title similarity and robust price-band filtering.
DELETE FROM "EbayMarketMetric";

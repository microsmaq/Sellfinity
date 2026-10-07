CREATE TABLE "AdminCatalogDailyActivity" (
  "asin" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "added" INTEGER NOT NULL DEFAULT 0,
  "refreshed" INTEGER NOT NULL DEFAULT 0,
  "checked" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "AdminCatalogDailyActivity_pkey" PRIMARY KEY ("asin", "day")
);
CREATE INDEX "AdminCatalogDailyActivity_day_idx" ON "AdminCatalogDailyActivity"("day");
CREATE TABLE "AdminCatalogActivityTracking" (
  "id" TEXT NOT NULL DEFAULT 'main',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminCatalogActivityTracking_pkey" PRIMARY KEY ("id")
);
INSERT INTO "AdminCatalogActivityTracking" ("id") VALUES ('main');

-- Import additions can be reconstructed accurately. Historical daily refresh
-- events cannot: retain that distinction instead of inventing missing history.
INSERT INTO "AdminCatalogDailyActivity" ("asin", "day", "added")
SELECT "asin", (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date, 1
FROM "AdminArbitrageProduct";

CREATE FUNCTION sellfinity_catalog_daily_activity() RETURNS TRIGGER AS $$
DECLARE
  activity_day DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date;
  added_flag INTEGER := 0;
  refreshed_flag INTEGER := 0;
  checked_flag INTEGER := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    added_flag := 1;
    refreshed_flag := CASE WHEN NEW."amazonRefreshedAt" IS NOT NULL THEN 1 ELSE 0 END;
    checked_flag := CASE WHEN NEW."amazonCheckedAt" IS NOT NULL THEN 1 ELSE 0 END;
  ELSE
    refreshed_flag := CASE WHEN NEW."amazonRefreshedAt" IS NOT NULL AND NEW."amazonRefreshedAt" IS DISTINCT FROM OLD."amazonRefreshedAt" THEN 1 ELSE 0 END;
    checked_flag := CASE WHEN NEW."amazonCheckedAt" IS NOT NULL AND NEW."amazonCheckedAt" IS DISTINCT FROM OLD."amazonCheckedAt" THEN 1 ELSE 0 END;
  END IF;
  IF added_flag + refreshed_flag + checked_flag > 0 THEN
    INSERT INTO "AdminCatalogDailyActivity" ("asin", "day", "added", "refreshed", "checked")
    VALUES (NEW."asin", activity_day, added_flag, refreshed_flag, checked_flag)
    ON CONFLICT ("asin", "day") DO UPDATE SET
      "added" = GREATEST("AdminCatalogDailyActivity"."added", EXCLUDED."added"),
      "refreshed" = GREATEST("AdminCatalogDailyActivity"."refreshed", EXCLUDED."refreshed"),
      "checked" = GREATEST("AdminCatalogDailyActivity"."checked", EXCLUDED."checked");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sellfinity_catalog_daily_activity_trigger
AFTER INSERT OR UPDATE ON "AdminArbitrageProduct"
FOR EACH ROW EXECUTE FUNCTION sellfinity_catalog_daily_activity();

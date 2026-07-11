export type RuntimeEnvironment = "development" | "test" | "production";

/**
 * Refuse to boot a non-production process against production data.
 *
 * Local development shares the Neon database instance but uses its own
 * Postgres schema. Integration tests use a separate database because they
 * intentionally clear tables between tests.
 */
export function assertDatabaseIsolation(
  databaseUrl: string | undefined,
  environment: RuntimeEnvironment,
): void {
  if (environment === "production") return;
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is invalid.");
  }

  const database = url.pathname.replace(/^\//, "");
  const schema = url.searchParams.get("schema") ?? "public";

  if (environment === "test") {
    if (database !== "sellfinity_test") {
      throw new Error(
        `Tests must use the sellfinity_test database, not ${database || "an unnamed database"}.`,
      );
    }
    return;
  }

  if (schema !== "sellfinity_dev") {
    throw new Error(
      `Local development must use the sellfinity_dev schema, not ${schema}. ` +
        "Add schema=sellfinity_dev to DATABASE_URL and DIRECT_DATABASE_URL.",
    );
  }
}

import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests run against the dedicated TEST_DATABASE_URL database (wiped between
// tests) — never the app database.
process.loadEnvFile?.(path.resolve(__dirname, ".env"));
const testDbUrl = process.env.TEST_DATABASE_URL ?? "";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      DATABASE_URL: testDbUrl,
      DIRECT_DATABASE_URL: testDbUrl,
      // Tests are hermetic: never select the real (paid) data providers.
      RAINFOREST_API_KEY: "",
      ALLOW_MOCK_SCAN: "1",
    },
    // The integration suite shares one database — no parallel files. The
    // database is remote (Neon), so multi-query tests need generous time.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

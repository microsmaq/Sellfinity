import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests run against a throwaway SQLite db (prisma/test.db), never dev.db.
    env: { DATABASE_URL: "file:./test.db" },
    // The integration suite shares one database file — no parallel files.
    fileParallelism: false,
  },
});

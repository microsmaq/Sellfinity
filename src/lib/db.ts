import { PrismaClient } from "@prisma/client";
import { assertDatabaseIsolation, type RuntimeEnvironment } from "./db-isolation";

assertDatabaseIsolation(
  process.env.DATABASE_URL,
  (process.env.NODE_ENV ?? "development") as RuntimeEnvironment,
);

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

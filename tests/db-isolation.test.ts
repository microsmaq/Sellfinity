import { describe, expect, it } from "vitest";
import { assertDatabaseIsolation } from "@/lib/db-isolation";

const url = (database: string, schema?: string) =>
  `postgresql://user:pass@db.example/${database}?sslmode=require${
    schema ? `&schema=${schema}` : ""
  }`;

describe("assertDatabaseIsolation", () => {
  it("allows only the development schema during local development", () => {
    expect(() =>
      assertDatabaseIsolation(url("neondb", "sellfinity_dev"), "development"),
    ).not.toThrow();
    expect(() => assertDatabaseIsolation(url("neondb"), "development")).toThrow(
      "sellfinity_dev",
    );
  });

  it("allows only the dedicated test database during tests", () => {
    expect(() => assertDatabaseIsolation(url("sellfinity_test"), "test")).not.toThrow();
    expect(() => assertDatabaseIsolation(url("neondb", "sellfinity_dev"), "test")).toThrow(
      "sellfinity_test",
    );
  });

  it("does not constrain the production database layout", () => {
    expect(() => assertDatabaseIsolation(url("neondb"), "production")).not.toThrow();
  });

  it("rejects missing and malformed non-production URLs", () => {
    expect(() => assertDatabaseIsolation(undefined, "development")).toThrow(
      "not configured",
    );
    expect(() => assertDatabaseIsolation("not a url", "test")).toThrow("invalid");
  });
});

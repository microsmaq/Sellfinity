import { describe, expect, it } from "vitest";
import { buildBatchCompletionEmail } from "@/lib/email/batch-completion-template";

describe("batch completion email", () => {
  it("summarizes published, failed, and total active listings", () => {
    const message = buildBatchCompletionEmail({
      name: "Ada Lovelace",
      batchId: "batch-123",
      source: "ARBITRAGE",
      trigger: "AUTOMATIC",
      succeededCount: 8,
      failedCount: 2,
      totalCount: 10,
      activeListingCount: 47,
      completedAt: new Date("2026-07-15T20:00:00.000Z"),
      appUrl: "https://www.sellfinity.app/",
    });

    expect(message.subject).toContain("8 new listings published");
    expect(message.text).toContain("Hi Ada,");
    expect(message.text).toContain("automatic Arbitrage Finder publishing batch");
    expect(message.text).toContain("New items published: 8");
    expect(message.text).toContain("Items that need attention: 2");
    expect(message.text).toContain("Success rate: 80%");
    expect(message.text).toContain("Total active listings now: 47");
    expect(message.text).toContain("https://www.sellfinity.app/mirror/batches/batch-123");
  });

  it("escapes the user's name in HTML", () => {
    const message = buildBatchCompletionEmail({
      name: "<Admin>",
      batchId: "safe-id",
      source: "URL_BULK",
      trigger: "MANUAL",
      succeededCount: 1,
      failedCount: 0,
      totalCount: 1,
      activeListingCount: 1,
      completedAt: new Date("2026-07-15T20:00:00.000Z"),
      appUrl: "https://www.sellfinity.app",
    });

    expect(message.html).toContain("Hi &lt;Admin&gt;,");
    expect(message.html).not.toContain("Hi <Admin>,");
  });
});

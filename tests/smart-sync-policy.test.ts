import { describe, expect, it } from "vitest";
import {
  isSmartSyncRecoverableEndReason,
  SMART_SYNC_RECOVERABLE_END_REASONS,
} from "@/lib/listings/smart-sync-policy";

describe("Smart Sync recovery policy", () => {
  it("allows source-unavailable and manually ended listings to recover", () => {
    expect(SMART_SYNC_RECOVERABLE_END_REASONS).toEqual([
      "SOURCE_UNAVAILABLE",
      "MANUAL",
    ]);
    expect(isSmartSyncRecoverableEndReason("SOURCE_UNAVAILABLE")).toBe(true);
    expect(isSmartSyncRecoverableEndReason("MANUAL")).toBe(true);
  });

  it("does not recover listings ended outside Sellfinity", () => {
    expect(isSmartSyncRecoverableEndReason("EBAY_ENDED")).toBe(false);
    expect(isSmartSyncRecoverableEndReason(null)).toBe(false);
  });
});

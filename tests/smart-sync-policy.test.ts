import { describe, expect, it } from "vitest";
import {
  isSmartSyncRecoverableEndReason,
  SMART_SYNC_RECOVERABLE_END_REASONS,
  shouldEndUnavailableSourceListing,
  failedSmartSyncListingIds,
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

  it("delists a confirmed unusable source only when the option is checked", () => {
    const input = {
      confirmedNoUsableSource: true,
      listingStatus: "ACTIVE",
      hasEbayListingId: true,
    };
    expect(shouldEndUnavailableSourceListing({ ...input, endUnavailableListings: true })).toBe(true);
    expect(shouldEndUnavailableSourceListing({ ...input, endUnavailableListings: false })).toBe(false);
  });

  it("never delists for a transient lookup failure", () => {
    expect(shouldEndUnavailableSourceListing({
      confirmedNoUsableSource: false,
      endUnavailableListings: true,
      listingStatus: "ACTIVE",
      hasEbayListingId: true,
    })).toBe(false);
  });

  it("retries only unique failed listings from the previous run", () => {
    expect(failedSmartSyncListingIds([
      { status: "SUCCEEDED", listingId: "successful" },
      { status: "FAILED", listingId: "failed-1" },
      { status: "FAILED", listingId: "failed-1" },
      { status: "FAILED", listingId: "failed-2" },
      { status: "FAILED", listingId: null },
    ])).toEqual(["failed-1", "failed-2"]);
  });
});

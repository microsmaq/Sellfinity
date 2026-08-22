import { describe, expect, it } from "vitest";
import {
  DEFAULT_SMART_SYNC_OPTIONS,
  hasSelectedSmartSyncOption,
  selectedSmartSyncOptionCount,
  type SmartSyncOptions,
} from "@/lib/listings/smart-sync-options";

describe("configurable Smart Sync options", () => {
  it("uses a safe recommended default without bulk pricing or image changes", () => {
    expect(DEFAULT_SMART_SYNC_OPTIONS).toEqual({
      refreshEbayListings: true,
      refreshAmazonData: true,
      applySuggestedPrices: false,
      updateListingImages: false,
      endUnavailableListings: true,
      relistRecoveredProducts: true,
    });
    expect(selectedSmartSyncOptionCount(DEFAULT_SMART_SYNC_OPTIONS)).toBe(4);
  });

  it("requires at least one selected operation", () => {
    const none: SmartSyncOptions = {
      refreshEbayListings: false,
      refreshAmazonData: false,
      applySuggestedPrices: false,
      updateListingImages: false,
      endUnavailableListings: false,
      relistRecoveredProducts: false,
    };
    expect(hasSelectedSmartSyncOption(none)).toBe(false);
    expect(selectedSmartSyncOptionCount(none)).toBe(0);
  });

  it("recognizes a single selected operation", () => {
    expect(hasSelectedSmartSyncOption({
      ...DEFAULT_SMART_SYNC_OPTIONS,
      refreshEbayListings: false,
      refreshAmazonData: false,
      endUnavailableListings: false,
      relistRecoveredProducts: false,
      applySuggestedPrices: true,
    })).toBe(true);
  });
});

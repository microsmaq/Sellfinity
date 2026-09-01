export type SmartSyncOptions = {
  refreshEbayListings: boolean;
  refreshAmazonData: boolean;
  checkLiveAmazonPrices: boolean;
  applySuggestedPrices: boolean;
  updateListingImages: boolean;
  endUnavailableListings: boolean;
  relistRecoveredProducts: boolean;
};

export const DEFAULT_SMART_SYNC_OPTIONS: SmartSyncOptions = {
  refreshEbayListings: true,
  refreshAmazonData: true,
  checkLiveAmazonPrices: false,
  applySuggestedPrices: false,
  updateListingImages: false,
  endUnavailableListings: true,
  relistRecoveredProducts: true,
};

export function hasSelectedSmartSyncOption(options: SmartSyncOptions): boolean {
  return Object.values(options).some(Boolean);
}

export function selectedSmartSyncOptionCount(options: SmartSyncOptions): number {
  return Object.values(options).filter(Boolean).length;
}

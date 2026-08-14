// eBay seller API client interface, shaped after the eBay Sell APIs
// (Inventory API for listings, Fulfillment API for orders) so a real
// implementation slots in behind getEbayClient() without touching callers.

export type CreateListingInput = {
  title: string;
  description: string;
  priceCents: number;
  quantity: number;
  imageUrls: string[];
  sku: string;
  category: string;
};

export type ListingUpdate = {
  priceCents?: number;
  quantity?: number;
  title?: string;
  description?: string;
  imageUrls?: string[];
};

/** An order as returned by eBay (Fulfillment API shape, simplified). */
export type RemoteOrder = {
  ebayOrderId: string;
  ebayListingId: string;
  quantity: number;
  salePriceCents: number; // per unit
  shippingChargedCents: number;
  /** Fee eBay actually charged, when the API reports it; import falls back
   * to the local fee model when absent (the sandbox client omits it). */
  feeCents?: number;
  buyerUsername: string;
  shippingRecipientName?: string | null;
  shippingAddressLine1?: string | null;
  shippingPostalCode?: string | null;
  saleDate: Date;
};

export type RemoteFulfillmentLine = {
  lineItemId: string;
  ebayListingId: string;
  sku: string | null;
  title: string;
  quantity: number;
  salePriceCents: number;
  shippingChargedCents: number;
  fulfillmentStatus: "NOT_STARTED" | "IN_PROGRESS";
  shipByDate: Date | null;
  variation: string | null;
};

export type RemoteFulfillmentOrder = {
  orderId: string;
  createdAt: Date;
  buyerUsername: string;
  shippingRecipientName?: string | null;
  shippingAddressLine1?: string | null;
  shippingPostalCode?: string | null;
  paymentStatus: string;
  fulfillmentStatus: "NOT_STARTED" | "IN_PROGRESS";
  lines: RemoteFulfillmentLine[];
};

export type ShippingFulfillmentInput = {
  orderId: string;
  lineItemId: string;
  quantity: number;
  trackingNumber: string;
  shippingCarrierCode: string;
  shippedDate?: Date;
};

/** One of the seller's live eBay listings, regardless of how it was created. */
export type RemoteListing = {
  /** Legacy numeric item id (the one in ebay.com/itm/… URLs). */
  ebayListingId: string;
  title: string;
  priceCents: number;
  url: string;
  imageUrl: string | null;
  quantity: number | null; // null when eBay doesn't expose it
  /** When the listing first went live, if exposed by eBay. */
  listingDate?: Date | null;
};

export type ListingTrafficMetric = {
  ebayListingId: string;
  impressions: number | null;
  views: number | null;
  clickThroughRate: number | null;
  salesConversionRate: number | null;
};

export class EbayApiError extends Error {}

export interface EbayClient {
  /** Publish a listing; returns the live eBay listing id. */
  createListing(input: CreateListingInput): Promise<{ ebayListingId: string }>;
  /** Revise mutable fields on a live listing. */
  updateListing(ebayListingId: string, update: ListingUpdate): Promise<void>;
  /** End a live listing. */
  endListing(ebayListingId: string): Promise<void>;
  /**
   * Orders created since `since` for this seller. userId identifies whose
   * account/tokens to use.
   */
  getOrders(userId: string, since: Date): Promise<RemoteOrder[]>;
  /** Paid, non-cancelled orders that still contain line items to fulfill. */
  getUnfulfilledOrders(userId: string): Promise<RemoteFulfillmentOrder[]>;
  /** Mark one paid order line as shipped and attach carrier tracking. */
  createShippingFulfillment(userId: string, input: ShippingFulfillmentInput): Promise<void>;
  /**
   * Every listing currently live on the seller's account — including ones
   * not created through this app.
   */
  getSellerListings(userId: string): Promise<RemoteListing[]>;
  /** Buyer engagement for the requested listings over a date range. */
  getListingTraffic?(
    userId: string,
    ebayListingIds: string[],
    start: Date,
    end: Date,
  ): Promise<ListingTrafficMetric[]>;
}

/** Validation eBay itself enforces; the mock applies it too so failures show up in dev. */
export function validateListingInput(input: CreateListingInput): string | null {
  if (input.title.length === 0) return "Title is required";
  if (input.title.length > 80) return "Title exceeds eBay's 80 character limit";
  if (input.priceCents < 99) return "Price must be at least $0.99";
  if (input.quantity < 1) return "Quantity must be at least 1";
  if (input.imageUrls.length === 0) return "At least one image is required";
  return null;
}

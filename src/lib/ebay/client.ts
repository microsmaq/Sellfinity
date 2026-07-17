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
  saleDate: Date;
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
  /**
   * Every listing currently live on the seller's account — including ones
   * not created through this app.
   */
  getSellerListings(userId: string): Promise<RemoteListing[]>;
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

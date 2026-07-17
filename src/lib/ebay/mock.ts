// Mock eBay client ("sandbox mode"). Applies the same validation real eBay
// would, mints realistic ids, and fabricates deterministic orders for active
// listings so the profit dashboard has live data. Swap for a real client in
// getEbayClient() when OAuth credentials exist.

import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import {
  EbayApiError,
  validateListingInput,
  type CreateListingInput,
  type EbayClient,
  type RemoteListing,
  type ListingUpdate,
  type RemoteOrder,
} from "./client";

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BUYERS = [
  "vintage_hunter88", "dealfinder_mike", "casa_bonita_shop", "quickship_carla",
  "tampa.treasures", "brooklyn_bins", "yardsale_yoda", "midwest_maggie",
  "pnw_picker", "flip4profit_dan", "sunny.finds", "thrifty_theresa",
];

const DAY_MS = 86_400_000;

/**
 * Deterministic orders for one listing on one calendar day (UTC). Cheaper
 * items sell more often; expected rate is roughly 0-2 orders/day scaled by
 * price band.
 */
export function ordersForListingDay(listing: {
  id: string;
  ebayListingId: string;
  priceCents: number;
  publishedAt: Date;
}, dayNumber: number): RemoteOrder[] {
  const publishedDay = Math.floor(listing.publishedAt.getTime() / DAY_MS);
  if (dayNumber < publishedDay) return [];

  const rand = mulberry32(hashString(`${listing.ebayListingId}:${dayNumber}`));
  // Daily sale probability by price band: cheap items move faster.
  const p =
    listing.priceCents < 1500 ? 0.55 : listing.priceCents < 2500 ? 0.4 : 0.25;

  const orders: RemoteOrder[] = [];
  const count = rand() < p ? (rand() < 0.2 ? 2 : 1) : 0;
  for (let i = 0; i < count; i++) {
    const hourOffset = Math.floor(rand() * 24);
    orders.push({
      ebayOrderId: `SBX-${hashString(`${listing.ebayListingId}:${dayNumber}:${i}`).toString(36).toUpperCase()}`,
      ebayListingId: listing.ebayListingId,
      quantity: rand() < 0.12 ? 2 : 1,
      salePriceCents: listing.priceCents,
      shippingChargedCents: 0, // free-shipping listings
      buyerUsername: BUYERS[Math.floor(rand() * BUYERS.length)],
      saleDate: new Date(dayNumber * DAY_MS + hourOffset * 3_600_000),
    });
  }
  return orders;
}

export class MockEbayClient implements EbayClient {
  async createListing(input: CreateListingInput): Promise<{ ebayListingId: string }> {
    const error = validateListingInput(input);
    if (error) throw new EbayApiError(error);
    return { ebayListingId: `110${randomBytes(5).readUIntBE(0, 5) % 1_000_000_000}` };
  }

  async updateListing(ebayListingId: string, update: ListingUpdate): Promise<void> {
    if (update.priceCents !== undefined && update.priceCents < 99) {
      throw new EbayApiError("Price must be at least $0.99");
    }
    if (update.quantity !== undefined && update.quantity < 0) {
      throw new EbayApiError("Quantity cannot be negative");
    }
    if (update.title !== undefined && (update.title.length === 0 || update.title.length > 80)) {
      throw new EbayApiError("Title must be between 1 and 80 characters");
    }
    if (update.description !== undefined && (update.description.length === 0 || update.description.length > 4000)) {
      throw new EbayApiError("Description must be between 1 and 4000 characters");
    }
    if (update.imageUrls !== undefined && update.imageUrls.length === 0) {
      throw new EbayApiError("At least one image is required");
    }
    // Real client would call eBay here; sandbox accepts silently.
  }

  async endListing(): Promise<void> {
    // Real client would call eBay here; sandbox accepts silently.
  }

  async getSellerListings(userId: string): Promise<RemoteListing[]> {
    // The demo sandbox's "remote truth" is our own ACTIVE listings.
    const listings = await db.listing.findMany({
      where: { userId, status: "ACTIVE", ebayListingId: { not: null } },
    });
    return listings.map((l) => ({
      ebayListingId: l.ebayListingId!,
      title: l.title,
      priceCents: l.priceCents,
      url: `https://sandbox.ebay.com/itm/${l.ebayListingId}`,
      imageUrl: (JSON.parse(l.imageUrlsJson) as string[])[0] ?? null,
      quantity: l.quantity,
    }));
  }

  async getOrders(userId: string, since: Date): Promise<RemoteOrder[]> {
    const listings = await db.listing.findMany({
      // quantity 0 = eBay's out-of-stock control: still listed, not buyable.
      where: { userId, status: "ACTIVE", ebayListingId: { not: null }, quantity: { gt: 0 } },
    });
    const now = Date.now();
    const firstDay = Math.floor(since.getTime() / DAY_MS);
    const lastDay = Math.floor(now / DAY_MS);

    const orders: RemoteOrder[] = [];
    for (const listing of listings) {
      if (!listing.publishedAt || !listing.ebayListingId) continue;
      for (let day = firstDay; day <= lastDay; day++) {
        const dayOrders = ordersForListingDay(
          {
            id: listing.id,
            ebayListingId: listing.ebayListingId,
            priceCents: listing.priceCents,
            publishedAt: listing.publishedAt,
          },
          day,
        );
        for (const o of dayOrders) {
          if (o.saleDate.getTime() >= since.getTime() && o.saleDate.getTime() <= now) {
            orders.push(o);
          }
        }
      }
    }
    return orders.sort((a, b) => a.saleDate.getTime() - b.saleDate.getTime());
  }
}

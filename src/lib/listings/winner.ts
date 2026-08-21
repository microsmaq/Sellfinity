import "server-only";

import { db } from "@/lib/db";
import { ebayAdvertisingFeeCents } from "@/lib/fees";
import {
  assessProfitableSalePriceLock,
  assessVerifiedWinner,
  type ProfitableSaleLockStatus,
  type VerifiedWinnerStatus,
} from "./winner-policy";

export type VerifiedWinnerListing = VerifiedWinnerStatus & { listingId: string };
export type ProfitableSalePriceLock = ProfitableSaleLockStatus & { listingId: string };
export type ProtectedPriceListing =
  | (VerifiedWinnerListing & { protectionKind: "VERIFIED_WINNER" })
  | (ProfitableSalePriceLock & { protectionKind: "PROFITABLE_SALE" });

export type ListingPriceProtection = {
  verifiedWinners: Map<string, VerifiedWinnerListing>;
  profitableSaleLocks: Map<string, ProfitableSalePriceLock>;
};

/** Return active winner locks from recent, non-cancelled sales. */
export async function getListingPriceProtection(
  userId: string,
  adRateBps: number,
  now = new Date(),
): Promise<ListingPriceProtection> {
  const preference = await db.user.findUnique({
    where: { id: userId },
    select: { autoLockProfitableListings: true },
  });
  const orders = await db.order.findMany({
    where: {
      userId,
      status: { not: "REFUNDED" },
      sourcingStatus: { not: "CANCELLED" },
      saleDate: { gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) },
    },
    select: {
      listingId: true,
      saleDate: true,
      quantity: true,
      salePriceCents: true,
      shippingChargedCents: true,
      ebayFeeCents: true,
      cogsCents: true,
      shippingCostCents: true,
    },
  });
  const byListing = new Map<string, Array<{ saleDate: Date; quantity: number; profitCents: number }>>();
  for (const order of orders) {
    const revenueCents = order.salePriceCents * order.quantity + order.shippingChargedCents;
    const profitCents = revenueCents
      - order.ebayFeeCents
      - ebayAdvertisingFeeCents(revenueCents, adRateBps)
      - order.cogsCents
      - order.shippingCostCents;
    const rows = byListing.get(order.listingId) ?? [];
    rows.push({ saleDate: order.saleDate, quantity: order.quantity, profitCents });
    byListing.set(order.listingId, rows);
  }

  const winners = new Map<string, VerifiedWinnerListing>();
  const profitableSaleLocks = new Map<string, ProfitableSalePriceLock>();
  for (const [listingId, listingOrders] of byListing) {
    const status = assessVerifiedWinner(listingOrders, now);
    if (status.isWinner) winners.set(listingId, { listingId, ...status });
    if (preference?.autoLockProfitableListings) {
      const lock = assessProfitableSalePriceLock(listingOrders, now);
      if (lock.isLocked) profitableSaleLocks.set(listingId, { listingId, ...lock });
    }
  }
  return { verifiedWinners: winners, profitableSaleLocks };
}

/** Return only listings that meet the established repeat-sales winner rule. */
export async function getVerifiedWinnerListings(
  userId: string,
  adRateBps: number,
  now = new Date(),
): Promise<Map<string, VerifiedWinnerListing>> {
  return (await getListingPriceProtection(userId, adRateBps, now)).verifiedWinners;
}

/** Return listings locked by the user's default-on first profitable sale preference. */
export async function getProfitableSalePriceLocks(
  userId: string,
  adRateBps: number,
  now = new Date(),
): Promise<Map<string, ProfitableSalePriceLock>> {
  return (await getListingPriceProtection(userId, adRateBps, now)).profitableSaleLocks;
}

/** Union used by every automatic or manual repricing safeguard. */
export async function getProtectedPriceListings(
  userId: string,
  adRateBps: number,
  now = new Date(),
): Promise<Map<string, ProtectedPriceListing>> {
  const protection = await getListingPriceProtection(userId, adRateBps, now);
  const result = new Map<string, ProtectedPriceListing>();
  for (const [listingId, lock] of protection.profitableSaleLocks) {
    result.set(listingId, { ...lock, protectionKind: "PROFITABLE_SALE" });
  }
  for (const [listingId, winner] of protection.verifiedWinners) {
    result.set(listingId, { ...winner, protectionKind: "VERIFIED_WINNER" });
  }
  return result;
}

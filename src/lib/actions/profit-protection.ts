"use server";

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { protectVerifiedOrderMargins } from "@/lib/orders/profit-protection";
import { getProtectedPriceListings } from "@/lib/listings/winner";
import { revalidatePath } from "next/cache";
import { normalizePricingStrategy, type PricingStrategy } from "@/lib/listings/shipping-strategy";
import { normalizeTargetProfitMode, type TargetProfitMode } from "@/lib/listings/target-profit";

export async function setAutoProfitProtection(enabled: boolean) {
  const user = await requireUser();
  await db.user.update({ where: { id: user.id }, data: { autoProtectVerifiedProfit: enabled } });
  return { enabled };
}

export async function setEbaySitewideDiscount(percent: number) {
  const user = await requireUser();
  if (!Number.isFinite(percent) || percent < 0 || percent > 50) {
    return { error: "Enter a discount from 0% to 50%." };
  }
  const discountBps = Math.round(percent * 100);
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { ebaySitewideDiscountBps: discountBps } }),
    db.order.updateMany({
      where: { userId: user.id, profitProtectionStatus: { not: null } },
      data: {
        profitProtectionStatus: null,
        profitProtectionReviewedAt: null,
        profitProtectionError: null,
      },
    }),
  ]);
  return { discountBps };
}

export async function setDefaultTargetProfit(enabled: boolean, mode: TargetProfitMode, minimumDollars: number, maximumDollars: number) {
  const user = await requireUser();
  if (![minimumDollars, maximumDollars].every(Number.isFinite) || minimumDollars < 0 || maximumDollars < 0 || maximumDollars > 10_000) {
    return { error: "Enter profit targets from $0 to $10,000 per item." };
  }
  const targetProfitMode = normalizeTargetProfitMode(mode);
  const targetProfitMinCents = Math.round(minimumDollars * 100);
  const targetProfitCents = Math.round(maximumDollars * 100);
  if (targetProfitMinCents > targetProfitCents) {
    return { error: "Minimum profit cannot be higher than maximum profit." };
  }
  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { targetProfitEnabled: enabled, targetProfitMode, targetProfitMinCents, targetProfitCents },
    }),
    db.order.updateMany({
      where: { userId: user.id, profitProtectionStatus: { not: null } },
      data: {
        profitProtectionStatus: null,
        profitProtectionReviewedAt: null,
        profitProtectionError: null,
      },
    }),
  ]);
  revalidatePath("/settings");
  revalidatePath("/listings");
  revalidatePath("/orders");
  revalidatePath("/analytics");
  return { enabled, targetProfitMode, targetProfitMinCents, targetProfitCents };
}

export async function setPricingStrategy(strategy: PricingStrategy) {
  const user = await requireUser();
  const normalized = normalizePricingStrategy(strategy);
  await db.user.update({ where: { id: user.id }, data: { pricingStrategy: normalized } });
  revalidatePath("/settings");
  revalidatePath("/listings");
  return { strategy: normalized };
}

export async function setAutoLockProfitableListings(enabled: boolean) {
  const user = await requireUser();
  await db.user.update({
    where: { id: user.id },
    data: { autoLockProfitableListings: enabled },
  });
  revalidatePath("/settings");
  revalidatePath("/listings");
  revalidatePath("/orders");
  revalidatePath("/analytics");
  return { enabled };
}

export async function setEbayAdRate(percent: number) {
  const user = await requireUser();
  if (!Number.isFinite(percent) || percent < 0 || percent > 50) {
    return { error: "Enter an advertising rate from 0% to 50%." };
  }
  const adRateBps = Math.round(percent * 100);
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { ebayAdRateBps: adRateBps } }),
    db.order.updateMany({
      where: { userId: user.id, profitProtectionStatus: { not: null } },
      data: {
        profitProtectionStatus: null,
        profitProtectionReviewedAt: null,
        profitProtectionError: null,
      },
    }),
  ]);
  revalidatePath("/settings");
  revalidatePath("/dashboard");
  revalidatePath("/orders");
  revalidatePath("/listings");
  revalidatePath("/analytics");
  return { adRateBps };
}

export async function protectOrderMargin(orderId: string, confirmVerifiedWinner = false) {
  const user = await requireUser();
  const owned = await db.order.findFirst({ where: { id: orderId, userId: user.id }, select: { id: true, listingId: true } });
  if (!owned) return { error: "Order not found." };
  const winnerListings = await getProtectedPriceListings(user.id, user.ebayAdRateBps);
  if (winnerListings.has(owned.listingId) && !confirmVerifiedWinner) {
    return { error: "This profitable listing's price is locked. Confirm the price-lock warning before changing it." };
  }
  const summary = await protectVerifiedOrderMargins(user.id, { orderIds: [orderId] });
  const order = await db.order.findFirst({
    where: { id: orderId, userId: user.id },
    select: {
      profitProtectionStatus: true,
      profitProtectionNewPriceCents: true,
      profitProtectionError: true,
    },
  });
  return { summary, order };
}

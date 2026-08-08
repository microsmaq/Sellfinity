"use server";

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { protectVerifiedOrderMargins } from "@/lib/orders/profit-protection";

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

export async function protectOrderMargin(orderId: string) {
  const user = await requireUser();
  const owned = await db.order.findFirst({ where: { id: orderId, userId: user.id }, select: { id: true } });
  if (!owned) return { error: "Order not found." };
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

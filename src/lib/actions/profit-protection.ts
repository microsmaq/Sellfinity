"use server";

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { protectVerifiedOrderMargins } from "@/lib/orders/profit-protection";

export async function setAutoProfitProtection(enabled: boolean) {
  const user = await requireUser();
  await db.user.update({ where: { id: user.id }, data: { autoProtectVerifiedProfit: enabled } });
  return { enabled };
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

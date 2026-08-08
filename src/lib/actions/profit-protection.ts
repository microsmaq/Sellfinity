"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { protectVerifiedOrderMargins } from "@/lib/orders/profit-protection";

function revalidateProfitViews() {
  revalidatePath("/orders");
  revalidatePath("/listings");
  revalidatePath("/dashboard");
}

export async function setAutoProfitProtection(enabled: boolean) {
  const user = await requireUser();
  await db.user.update({ where: { id: user.id }, data: { autoProtectVerifiedProfit: enabled } });
  revalidateProfitViews();
  return { enabled };
}

export async function protectOrderMargin(orderId: string) {
  const user = await requireUser();
  const owned = await db.order.findFirst({ where: { id: orderId, userId: user.id }, select: { id: true } });
  if (!owned) return { error: "Order not found." };
  const summary = await protectVerifiedOrderMargins(user.id, { orderIds: [orderId] });
  revalidateProfitViews();
  return { summary };
}

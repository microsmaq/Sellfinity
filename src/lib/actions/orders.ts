"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { importOrders } from "@/lib/orders/import";
import { restockLowFulfillmentInventory, type AutoRestockResult } from "@/lib/orders/auto-restock";

export async function setAutoRestockFulfilledListings(enabled: boolean) {
  const user = await requireUser();
  await db.user.update({
    where: { id: user.id },
    data: { autoRestockFulfilledListings: enabled },
  });
  let restock = null;
  let warning: string | null = null;
  if (enabled) {
    try {
      restock = await restockLowFulfillmentInventory(user.id);
    } catch (error) {
      warning = error instanceof Error ? error.message.slice(0, 200) : "The immediate eBay stock check failed.";
    }
  }
  revalidatePath("/orders");
  return { enabled, restock, warning };
}

export async function importOrdersNow(): Promise<
  { imported: number; restock: AutoRestockResult } | { error: string }
> {
  const user = await requireUser();
  const connection = await db.ebayConnection.findUnique({ where: { userId: user.id } });
  if (!connection || connection.status === "DISCONNECTED") {
    return { error: "Connect your eBay account in Settings before importing orders." };
  }
  const result = await importOrders(user.id);
  const restock = await restockLowFulfillmentInventory(user.id);
  revalidatePath("/dashboard");
  revalidatePath("/listings");
  revalidatePath("/orders");
  return { ...result, restock };
}

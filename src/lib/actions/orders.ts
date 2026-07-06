"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { importOrders } from "@/lib/orders/import";

export async function importOrdersNow(): Promise<
  { imported: number } | { error: string }
> {
  const user = await requireUser();
  const connection = await db.ebayConnection.findUnique({ where: { userId: user.id } });
  if (!connection || connection.status === "DISCONNECTED") {
    return { error: "Connect your eBay account in Settings before importing orders." };
  }
  const result = await importOrders(user.id);
  revalidatePath("/dashboard");
  revalidatePath("/listings");
  return result;
}

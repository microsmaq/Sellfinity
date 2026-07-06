"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export type SettingsResult = { error?: string };

const usernameSchema = z
  .string()
  .trim()
  .min(1, "Enter your eBay username")
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, "That doesn't look like an eBay username");

/**
 * Connect in sandbox mode: stores a placeholder connection so the rest of the
 * app (publish, sync, orders) works against the mock eBay client. The real
 * flow — eBay OAuth consent redirect + token exchange — replaces this once
 * eBay developer credentials are configured.
 */
export async function connectEbaySandbox(
  _prev: SettingsResult | null,
  formData: FormData,
): Promise<SettingsResult> {
  const user = await requireUser();
  const parsed = usernameSchema.safeParse(formData.get("username"));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  await db.ebayConnection.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      status: "SANDBOX",
      ebayUsername: parsed.data,
      accessToken: "sandbox-placeholder-token",
      connectedAt: new Date(),
    },
    update: {
      status: "SANDBOX",
      ebayUsername: parsed.data,
      accessToken: "sandbox-placeholder-token",
      connectedAt: new Date(),
    },
  });
  revalidatePath("/settings");
  revalidatePath("/listings");
  return {};
}

export async function disconnectEbay(): Promise<void> {
  const user = await requireUser();
  await db.ebayConnection.updateMany({
    where: { userId: user.id },
    data: {
      status: "DISCONNECTED",
      accessToken: null,
      refreshToken: null,
    },
  });
  revalidatePath("/settings");
  revalidatePath("/listings");
}

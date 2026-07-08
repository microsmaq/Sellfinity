"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { EbayApiError } from "@/lib/ebay/client";
import {
  completeConnection,
  ebayEnvConfig,
  parseCallbackUrl,
} from "@/lib/ebay/oauth";

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

/**
 * Complete the OAuth connection from a pasted post-consent redirect URL —
 * the fallback when eBay's accepted-URL field won't point at a local dev
 * server. Verifies the state from the consent redirect when present.
 */
export async function completeEbayConnectionFromUrl(
  _prev: SettingsResult | null,
  formData: FormData,
): Promise<SettingsResult> {
  const user = await requireUser();
  const config = ebayEnvConfig();
  if (!config) return { error: "eBay keyset is not configured in .env." };

  const parsed = parseCallbackUrl(String(formData.get("url") ?? ""));
  if (!parsed) {
    return { error: "That URL has no authorization code — paste the full URL from the address bar after granting consent." };
  }

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("ebay_oauth_state")?.value;
  cookieStore.delete("ebay_oauth_state");
  if (parsed.state && expectedState && parsed.state !== expectedState) {
    return { error: "This URL is from an older connect attempt — click Connect and try again with the fresh URL." };
  }

  try {
    await completeConnection(config, user.id, parsed.code);
  } catch (e) {
    if (e instanceof EbayApiError) {
      return { error: `eBay rejected the code (it expires after ~5 minutes): ${e.message.slice(0, 200)}` };
    }
    throw e;
  }
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

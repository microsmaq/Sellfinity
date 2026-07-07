import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { completeConnection, ebayEnvConfig } from "@/lib/ebay/oauth";
import { EbayApiError } from "@/lib/ebay/client";

/** eBay redirects here after the seller grants (or declines) consent. */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const config = ebayEnvConfig();
  const url = new URL(request.url);
  const settingsUrl = (params: string) => new URL(`/settings${params}`, request.url);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("ebay_oauth_state")?.value;
  cookieStore.delete("ebay_oauth_state");

  if (!config || !code) {
    return NextResponse.redirect(settingsUrl("?ebay=declined"));
  }
  if (!expectedState || state !== expectedState) {
    return NextResponse.redirect(settingsUrl("?ebay=state_mismatch"));
  }

  try {
    await completeConnection(config, user.id, code);
  } catch (e) {
    if (e instanceof EbayApiError) {
      console.error("eBay OAuth token exchange failed:", e.message);
      return NextResponse.redirect(settingsUrl("?ebay=token_error"));
    }
    throw e;
  }
  return NextResponse.redirect(settingsUrl("?ebay=connected"));
}

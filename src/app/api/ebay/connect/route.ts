import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { consentUrl, ebayEnvConfig } from "@/lib/ebay/oauth";

/** Kicks off the eBay OAuth consent flow. */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const config = ebayEnvConfig();
  if (!config) return NextResponse.redirect(new URL("/settings", request.url));

  const state = randomBytes(16).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set("ebay_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/",
  });
  return NextResponse.redirect(consentUrl(config, state));
}

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { encryptToken } from "@/lib/amazon-email/crypto";
import { exchangeGoogleCode } from "@/lib/amazon-email/oauth";

export async function GET(request: NextRequest) {
  const user = await requireUser();
  const url = new URL(request.url); const state = url.searchParams.get("state"); const code = url.searchParams.get("code");
  const cookieStore = await cookies(); const expected = cookieStore.get("amazon_email_oauth_state")?.value; cookieStore.delete("amazon_email_oauth_state");
  if (!code || !state || state !== expected) return NextResponse.redirect(new URL("/settings?amazon_email=failed", request.url));
  try {
    const token = await exchangeGoogleCode(code);
    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { authorization: `Bearer ${token.access_token}` } });
    const profile = profileResponse.ok ? await profileResponse.json() as { email?: string } : {};
    const prior = await db.amazonEmailConnection.findUnique({ where: { userId: user.id } });
    await db.amazonEmailConnection.upsert({ where: { userId: user.id }, create: { userId: user.id, email: profile.email, encryptedAccessToken: encryptToken(token.access_token), encryptedRefreshToken: token.refresh_token ? encryptToken(token.refresh_token) : null, accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000) }, update: { status: "CONNECTED", email: profile.email, encryptedAccessToken: encryptToken(token.access_token), encryptedRefreshToken: token.refresh_token ? encryptToken(token.refresh_token) : prior?.encryptedRefreshToken, accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000), connectedAt: new Date(), lastSyncError: null } });
    return NextResponse.redirect(new URL("/settings?amazon_email=connected", request.url));
  } catch {
    return NextResponse.redirect(new URL("/settings?amazon_email=failed", request.url));
  }
}

import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth";
import { googleAuthorizationUrl } from "@/lib/amazon-email/oauth";

export async function GET() {
  await requireUser();
  const state = randomBytes(24).toString("hex");
  (await cookies()).set("amazon_email_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 600, path: "/" });
  return NextResponse.redirect(googleAuthorizationUrl(state));
}

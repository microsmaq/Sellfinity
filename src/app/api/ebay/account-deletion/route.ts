// eBay marketplace account-deletion endpoint — required for production
// keysets. Configure in the developer portal (Alerts & Notifications):
//   endpoint: https://sellfinity.app/api/ebay/account-deletion
//   verification token: the value of EBAY_VERIFICATION_TOKEN

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  computeChallengeResponse,
  extractDeletedUser,
} from "@/lib/ebay/deletion";

function endpointUrl(request: Request): string {
  const url = new URL(request.url);
  // Behind Vercel's proxy the request URL is http; eBay hashes the public
  // https URL it was configured with.
  url.protocol = "https:";
  url.search = "";
  return url.toString();
}

/** eBay's endpoint-validation challenge. */
export async function GET(request: Request) {
  const token = process.env.EBAY_VERIFICATION_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  const challengeCode = new URL(request.url).searchParams.get("challenge_code");
  if (!challengeCode) {
    return NextResponse.json({ error: "missing challenge_code" }, { status: 400 });
  }
  return NextResponse.json({
    challengeResponse: computeChallengeResponse(
      challengeCode,
      token,
      endpointUrl(request),
    ),
  });
}

/** A deletion notice: acknowledge fast and scrub the eBay user's data. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const deleted = extractDeletedUser(body);
  if (deleted?.username) {
    // The only eBay-user data we hold is the seller connection.
    await db.ebayConnection.updateMany({
      where: { ebayUsername: deleted.username },
      data: {
        status: "DISCONNECTED",
        ebayUsername: null,
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
      },
    });
  }
  return new NextResponse(null, { status: 200 });
}

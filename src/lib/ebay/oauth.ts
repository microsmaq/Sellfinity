// eBay OAuth 2.0 (authorization-code grant) against the sandbox or
// production environment, selected by EBAY_ENV. Docs:
// https://developer.ebay.com/api-docs/static/oauth-authorization-code-grant.html

import { db } from "@/lib/db";
import { EbayApiError } from "./client";

export type EbayEnvConfig = {
  env: "SANDBOX" | "PRODUCTION";
  clientId: string;
  clientSecret: string;
  ruName: string;
  authHost: string;
  apiHost: string;
};

/** The seller permissions SellPilot needs. */
export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
];

/** Reads the keyset from env; null when real eBay isn't configured. */
export function ebayEnvConfig(): EbayEnvConfig | null {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_RU_NAME;
  if (!clientId || !clientSecret || !ruName) return null;
  const env = process.env.EBAY_ENV === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
  return {
    env,
    clientId,
    clientSecret,
    ruName,
    authHost:
      env === "PRODUCTION" ? "https://auth.ebay.com" : "https://auth.sandbox.ebay.com",
    apiHost:
      env === "PRODUCTION" ? "https://api.ebay.com" : "https://api.sandbox.ebay.com",
  };
}

/** Consent-page URL the user is redirected to. `state` guards the callback. */
export function consentUrl(config: EbayEnvConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.ruName,
    scope: EBAY_SCOPES.join(" "),
    state,
  });
  return `${config.authHost}/oauth2/authorize?${params}`;
}

/**
 * Extract code and state from a pasted post-consent redirect URL. Used when
 * eBay can't redirect back to a local dev server (its accepted-URL field
 * rejects localhost): the user copies the dead page's URL from the address
 * bar and pastes it in Settings.
 */
export function parseCallbackUrl(
  input: string,
): { code: string; state: string | null } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const code = url.searchParams.get("code");
  if (!code) return null;
  return { code, state: url.searchParams.get("state") };
}

type TokenResponse = {
  access_token: string;
  expires_in: number; // seconds
  refresh_token?: string;
};

async function tokenRequest(
  config: EbayEnvConfig,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString(
    "base64",
  );
  const res = await fetch(`${config.apiHost}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) {
    throw new EbayApiError(`eBay token request failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Exchange the callback authorization code and store tokens on the connection. */
export async function completeConnection(
  config: EbayEnvConfig,
  userId: string,
  code: string,
): Promise<void> {
  const token = await tokenRequest(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.ruName,
    }),
  );
  const data = {
    status: "CONNECTED",
    ebayUsername: `${config.env.toLowerCase()} seller`,
    accessToken: token.access_token,
    accessTokenExpiresAt: new Date(Date.now() + (token.expires_in - 60) * 1000),
    refreshToken: token.refresh_token ?? null,
    connectedAt: new Date(),
  };
  await db.ebayConnection.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

// Application (client-credentials) token for app-level APIs like Taxonomy,
// which reject user tokens. Cached in memory until expiry.
let cachedAppToken: { token: string; expiresAt: number } | null = null;

export async function appAccessToken(config: EbayEnvConfig): Promise<string> {
  if (cachedAppToken && Date.now() < cachedAppToken.expiresAt) {
    return cachedAppToken.token;
  }
  const token = await tokenRequest(
    config,
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  );
  cachedAppToken = {
    token: token.access_token,
    expiresAt: Date.now() + (token.expires_in - 60) * 1000,
  };
  return token.access_token;
}

/** Valid access token for a connected user, refreshing via the stored
 * refresh token when expired. */
export async function freshAccessToken(
  config: EbayEnvConfig,
  userId: string,
): Promise<string> {
  const connection = await db.ebayConnection.findUnique({ where: { userId } });
  if (!connection || connection.status !== "CONNECTED" || !connection.accessToken) {
    throw new EbayApiError("eBay account is not connected.");
  }
  const stillValid =
    connection.accessTokenExpiresAt && connection.accessTokenExpiresAt > new Date();
  if (stillValid) return connection.accessToken;

  if (!connection.refreshToken) {
    throw new EbayApiError("eBay session expired — reconnect in Settings.");
  }
  const token = await tokenRequest(
    config,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: connection.refreshToken,
      scope: EBAY_SCOPES.join(" "),
    }),
  );
  await db.ebayConnection.update({
    where: { userId },
    data: {
      accessToken: token.access_token,
      accessTokenExpiresAt: new Date(Date.now() + (token.expires_in - 60) * 1000),
    },
  });
  return token.access_token;
}

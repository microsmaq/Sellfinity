import { db } from "@/lib/db";
import type { EbayClient } from "./client";
import { MockEbayClient } from "./mock";
import { RealEbayClient } from "./real";
import { ebayEnvConfig } from "./oauth";

const mockClient = new MockEbayClient();

/**
 * The eBay client for a user's connection:
 * - status CONNECTED (real OAuth tokens + keyset in env) → real Sell APIs
 *   against the environment in EBAY_ENV;
 * - otherwise → the built-in demo sandbox (deterministic simulation).
 */
export async function getEbayClientForUser(userId: string): Promise<EbayClient> {
  const config = ebayEnvConfig();
  if (config) {
    const connection = await db.ebayConnection.findUnique({ where: { userId } });
    if (connection?.status === "CONNECTED") {
      return new RealEbayClient(userId, config);
    }
  }
  return mockClient;
}

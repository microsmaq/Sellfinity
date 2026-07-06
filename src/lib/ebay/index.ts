import type { EbayClient } from "./client";
import { MockEbayClient } from "./mock";

// Swap point for the real eBay integration: once real OAuth credentials are
// configured (see Settings), return a client that talks to the eBay Sell APIs.
const client: EbayClient = new MockEbayClient();

export function getEbayClient(): EbayClient {
  return client;
}

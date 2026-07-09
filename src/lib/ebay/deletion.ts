// eBay marketplace account-deletion notifications. Production keysets stay
// disabled until an endpoint answers eBay's challenge and acknowledges
// deletion notices:
// https://developer.ebay.com/marketplace-account-deletion

import { createHash } from "crypto";

/**
 * eBay's GET challenge: respond with
 * sha256(challengeCode + verificationToken + endpointUrl) as hex.
 */
export function computeChallengeResponse(
  challengeCode: string,
  verificationToken: string,
  endpointUrl: string,
): string {
  return createHash("sha256")
    .update(challengeCode)
    .update(verificationToken)
    .update(endpointUrl)
    .digest("hex");
}

/** Shape of the POST notification body (fields we use). */
export type DeletionNotification = {
  notification?: {
    data?: {
      username?: string;
      userId?: string;
    };
  };
};

export function extractDeletedUser(
  body: unknown,
): { username?: string; userId?: string } | null {
  const data = (body as DeletionNotification)?.notification?.data;
  if (!data || (!data.username && !data.userId)) return null;
  return { username: data.username, userId: data.userId };
}
